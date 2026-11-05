"""
Streaming API endpoints for media playback.
"""

import re
import logging
from fastapi import APIRouter, Depends, HTTPException, Request, Response, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from slowapi import Limiter
from slowapi.util import get_remote_address

from ..database import get_db
from ..models import File, User
from ..auth import get_current_user
from .. import telegram
from ..telegram import get_message_from_channel
from ..streaming import stream_file as stream_file_generator
from ..services import pick_cover_media, best_photo

# Logger for internal debugging (not exposed to users)
logger = logging.getLogger(__name__)

# Rate limiter for public endpoints
limiter = Limiter(key_func=get_remote_address)

router = APIRouter(prefix="/stream", tags=["Streaming"])


def parse_range_header(range_header: str, file_size: int) -> tuple[int, int]:
    """Parse HTTP Range header for video seeking support."""
    if not range_header:
        return 0, file_size - 1

    match = re.match(r"bytes=(\d+)-(\d*)", range_header)
    if not match:
        return 0, file_size - 1

    start = int(match.group(1))
    end = int(match.group(2)) if match.group(2) else file_size - 1

    return start, min(end, file_size - 1)


@router.get("/{file_id}")
async def stream_file(
    file_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    download: int = Query(0, description="Set to 1 to force download"),
):
    """Stream file from Telegram with range request support for seeking."""
    # Get file from database
    result = await db.execute(
        select(File).where(File.id == file_id, File.user_id == current_user.id)
    )
    file = result.scalar_one_or_none()

    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    file_size = file.file_size

    # Parse range header
    range_header = request.headers.get("range")
    from_bytes, until_bytes = parse_range_header(range_header, file_size)

    # Validate range
    if (until_bytes > file_size) or (from_bytes < 0) or (until_bytes < from_bytes):
        return Response(
            status_code=416,
            content="416: Range not satisfiable",
            headers={"Content-Range": f"bytes */{file_size}"},
        )

    req_length = until_bytes - from_bytes + 1

    # Get message from channel
    message = await get_message_from_channel(file.channel_message_id)
    if not message:
        raise HTTPException(status_code=404, detail="Message not found in channel")

    async def file_streamer():
        """Generator that streams file chunks from Telegram MTProto."""
        async for chunk in stream_file_generator(
            telegram.tg_client, message, from_bytes, until_bytes
        ):
            yield chunk

    # Determine content disposition
    mime_type = file.mime_type or "application/octet-stream"
    disposition = (
        "attachment"
        if download
        else (
            "inline"
            if ("video/" in mime_type or "audio/" in mime_type)
            else "attachment"
        )
    )

    from urllib.parse import quote

    encoded_filename = quote(file.file_name)

    headers = {
        "Content-Type": mime_type,
        "Content-Range": f"bytes {from_bytes}-{until_bytes}/{file_size}",
        "Content-Length": str(req_length),
        "Content-Disposition": f"{disposition}; filename*=utf-8''{encoded_filename}",
        "Accept-Ranges": "bytes",
    }

    return StreamingResponse(
        file_streamer(),
        status_code=206 if range_header else 200,
        media_type=mime_type,
        headers=headers,
    )


@router.get("/{file_id}/thumbnail")
async def get_thumbnail(
    file_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get file thumbnail."""
    # Get file from database
    result = await db.execute(
        select(File).where(File.id == file_id, File.user_id == current_user.id)
    )
    file = result.scalar_one_or_none()

    if not file or not file.thumbnail_file_id:
        raise HTTPException(status_code=404, detail="Thumbnail not found")

    # Custom cover set by the user:
    #   "cover:<telegram file_id>" -> image uploaded to the storage channel
    #   "file:<library file id>"   -> image taken from another file of the library
    # If anything goes wrong we fall through to the original thumbnail below.
    custom = file.thumbnail_file_id
    is_custom = custom.startswith(("cover:", "file:"))
    if custom.startswith("cover:"):
        try:
            data = await telegram.tg_client.download_media(
                custom[len("cover:") :], in_memory=True
            )
            return Response(content=data.getvalue(), media_type="image/jpeg")
        except Exception as e:
            logger.error(f"Custom cover error for file {file_id}: {e}")
    elif custom.startswith("file:"):
        try:
            source_id = int(custom[len("file:") :])
            source_res = await db.execute(
                select(File).where(
                    File.id == source_id, File.user_id == current_user.id
                )
            )
            source = source_res.scalar_one_or_none()
            if source:
                source_msg = await get_message_from_channel(source.channel_message_id)
                media = pick_cover_media(source_msg)
                if media:
                    data = await telegram.tg_client.download_media(
                        media.file_id, in_memory=True
                    )
                    return Response(
                        content=data.getvalue(),
                        media_type=getattr(media, "mime_type", None) or "image/jpeg",
                    )
        except Exception as e:
            logger.error(f"Cover-from-file error for file {file_id}: {e}")

    try:
        # Get the message and download thumbnail
        message = await get_message_from_channel(file.channel_message_id)
        if not message:
            raise HTTPException(status_code=404, detail="Message not found")

        # Extract thumbnail object
        thumbnail = None
        if message.video and message.video.thumbs:
            thumbnail = message.video.thumbs[0]
        elif message.document and message.document.thumbs:
            thumbnail = message.document.thumbs[0]
        elif message.audio and message.audio.thumbs:
            thumbnail = message.audio.thumbs[0]
        elif message.photo:
            thumbnail = best_photo(message.photo)  # Use best quality photo

        if not thumbnail:
            # Try using the file_id directly if stored (fallback)
            if file.thumbnail_file_id and not is_custom:
                try:
                    thumb_bytes = await telegram.tg_client.download_media(
                        file.thumbnail_file_id, in_memory=True
                    )
                    return Response(
                        content=thumb_bytes.getvalue(), media_type="image/jpeg"
                    )
                except Exception:
                    pass
            raise HTTPException(
                status_code=404, detail="Thumbnail not found in message"
            )

        # Download thumbnail to memory
        thumb_bytes = await telegram.tg_client.download_media(
            thumbnail.file_id, in_memory=True
        )

        return Response(content=thumb_bytes.getvalue(), media_type="image/jpeg")
    except Exception as e:
        # Log error internally, don't expose details to users
        logger.error(f"Thumbnail error for file {file_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to get thumbnail")


@router.get("/s/{public_hash}")
@limiter.limit("60/minute")  # Rate limit public streaming to prevent abuse
async def stream_public_file(
    public_hash: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    download: int = Query(0, description="Set to 1 to force download"),
):
    """Stream file via public link (no auth required)."""
    # Get file by hash
    result = await db.execute(select(File).where(File.public_hash == public_hash))
    file = result.scalar_one_or_none()

    if not file:
        raise HTTPException(status_code=404, detail="File not found or link revoked")

    file_size = file.file_size

    # Parse range header
    range_header = request.headers.get("range")
    from_bytes, until_bytes = parse_range_header(range_header, file_size)

    # Validate range
    if (until_bytes > file_size) or (from_bytes < 0) or (until_bytes < from_bytes):
        return Response(
            status_code=416,
            content="416: Range not satisfiable",
            headers={"Content-Range": f"bytes */{file_size}"},
        )

    req_length = until_bytes - from_bytes + 1

    # Get message from channel
    message = await get_message_from_channel(file.channel_message_id)
    if not message:
        raise HTTPException(status_code=404, detail="Message not found in channel")

    async def file_streamer():
        """Generator that streams file chunks from Telegram MTProto."""
        async for chunk in stream_file_generator(
            telegram.tg_client, message, from_bytes, until_bytes
        ):
            yield chunk

    # Determine content disposition
    mime_type = file.mime_type or "application/octet-stream"
    disposition = (
        "attachment"
        if download
        else (
            "inline"
            if ("video/" in mime_type or "audio/" in mime_type)
            else "attachment"
        )
    )

    from urllib.parse import quote

    encoded_filename = quote(file.file_name)

    headers = {
        "Content-Type": mime_type,
        "Content-Range": f"bytes {from_bytes}-{until_bytes}/{file_size}",
        "Content-Length": str(req_length),
        "Content-Disposition": f"{disposition}; filename*=utf-8''{encoded_filename}",
        "Accept-Ranges": "bytes",
    }

    return StreamingResponse(
        file_streamer(),
        status_code=206 if range_header else 200,
        media_type=mime_type,
        headers=headers,
    )
