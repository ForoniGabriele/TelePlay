"""
Folder management API endpoints.
"""
from typing import Optional, List
from pathlib import Path
import logging
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File as FastApiFile, Response
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from ..database import get_db
from ..models import Folder, File, User
from ..schemas import FolderResponse, FolderCreate, FolderUpdate, FolderWithChildren
from ..auth import get_current_user
from .. import telegram
from ..telegram import delete_from_storage_channel, get_message_from_channel
from ..config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/folders", tags=["Folders"])


def get_cover_path(folder_id: int) -> Path:
    """Return local path for storing a folder's cover image."""
    base = Path("session/covers")
    try:
        base.mkdir(parents=True, exist_ok=True)
        return base / f"{folder_id}.jpg"
    except Exception:
        fallback = Path("covers")
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback / f"{folder_id}.jpg"


def to_folder_response(folder: Folder, file_count: int = 0) -> FolderResponse:
    """Format Folder model to FolderResponse with computed cover_url."""
    cover_url = f"/api/folders/{folder.id}/cover" if folder.cover_file_id else None
    return FolderResponse(
        id=folder.id,
        name=folder.name,
        parent_id=folder.parent_id,
        user_id=folder.user_id,
        created_at=folder.created_at,
        updated_at=folder.updated_at,
        file_count=file_count,
        cover_file_id=folder.cover_file_id,
        cover_url=cover_url,
    )


async def get_folder_file_count(db: AsyncSession, folder_id: int) -> int:
    """Get the total number of files in a folder and all its subfolders."""
    from sqlalchemy import text
    query = text("""
        WITH RECURSIVE subfolders AS (
            SELECT id FROM folders WHERE id = :root_id
            UNION ALL
            SELECT f.id FROM folders f
            INNER JOIN subfolders sf ON f.parent_id = sf.id
        )
        SELECT COUNT(*) FROM files
        WHERE folder_id IN (SELECT id FROM subfolders)
    """)
    result = await db.execute(query, {"root_id": folder_id})
    return result.scalar() or 0


@router.get("", response_model=List[FolderResponse])
async def list_folders(
    parent_id: Optional[int] = Query(None, description="Filter by parent folder ID"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List user's folders optimally."""
    stmt = (
        select(Folder, func.count(File.id).label("file_count"))
        .outerjoin(File, File.folder_id == Folder.id)
        .where(Folder.user_id == current_user.id)
        .group_by(Folder.id)
        .order_by(Folder.name)
    )
    
    if parent_id is not None:
        stmt = stmt.where(Folder.parent_id == parent_id)
    else:
        stmt = stmt.where(Folder.parent_id.is_(None))
    
    result = await db.execute(stmt)
    rows = result.all()
    
    return [to_folder_response(folder, file_count) for folder, file_count in rows]


@router.get("/tree", response_model=List[FolderWithChildren])
async def get_folder_tree(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get the complete folder tree for the user optimally."""
    stmt = (
        select(Folder, func.count(File.id).label("file_count"))
        .outerjoin(File, File.folder_id == Folder.id)
        .where(Folder.user_id == current_user.id)
        .group_by(Folder.id)
        .order_by(Folder.name)
    )
    
    result = await db.execute(stmt)
    rows = result.all()
    
    folder_map = {}
    for folder, file_count in rows:
        folder_map[folder.id] = {
            "id": folder.id,
            "name": folder.name,
            "parent_id": folder.parent_id,
            "user_id": folder.user_id,
            "created_at": folder.created_at,
            "updated_at": folder.updated_at,
            "file_count": file_count,
            "cover_file_id": folder.cover_file_id,
            "cover_url": f"/api/folders/{folder.id}/cover" if folder.cover_file_id else None,
            "children": [],
        }
    
    roots = []
    for folder_data in folder_map.values():
        parent_id = folder_data["parent_id"]
        if parent_id and parent_id in folder_map:
            folder_map[parent_id]["children"].append(folder_data)
        else:
            roots.append(folder_data)
    
    return roots


@router.get("/{folder_id}", response_model=FolderResponse)
async def get_folder(
    folder_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a specific folder by ID with file count."""
    stmt = (
        select(Folder, func.count(File.id).label("file_count"))
        .outerjoin(File, File.folder_id == Folder.id)
        .where(Folder.id == folder_id, Folder.user_id == current_user.id)
        .group_by(Folder.id)
    )
    
    result = await db.execute(stmt)
    row = result.first()
    
    if not row:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    folder, file_count = row
    return to_folder_response(folder, file_count)


@router.get("/{folder_id}/cover")
async def get_folder_cover(
    folder_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get folder cover image."""
    result = await db.execute(
        select(Folder).where(Folder.id == folder_id, Folder.user_id == current_user.id)
    )
    folder = result.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
        
    if not folder.cover_file_id:
        raise HTTPException(status_code=404, detail="Cover image not set")
    
    # 1. Check local file on disk
    cover_path = get_cover_path(folder_id)
    if cover_path.exists():
        return FileResponse(cover_path, media_type="image/jpeg")
    
    alt_path = Path("covers") / f"{folder_id}.jpg"
    if alt_path.exists():
        return FileResponse(alt_path, media_type="image/jpeg")

    # 2. If cover_file_id is reference to a file in library: "file:{file_id}"
    if folder.cover_file_id.startswith("file:"):
        try:
            source_id = int(folder.cover_file_id.split(":", 1)[1])
            file_res = await db.execute(
                select(File).where(File.id == source_id, File.user_id == current_user.id)
            )
            source_file = file_res.scalar_one_or_none()
            if source_file and telegram.tg_client:
                message = await get_message_from_channel(source_file.channel_message_id)
                thumb = None
                if message:
                    if message.video and message.video.thumbs:
                        thumb = message.video.thumbs[0]
                    elif message.document and message.document.thumbs:
                        thumb = message.document.thumbs[0]
                    elif message.audio and message.audio.thumbs:
                        thumb = message.audio.thumbs[0]
                    elif message.photo:
                        thumb = message.photo[-1]
                if thumb:
                    thumb_bytes = await telegram.tg_client.download_media(thumb.file_id, in_memory=True)
                    data = thumb_bytes.getvalue()
                    try:
                        cover_path.write_bytes(data)
                    except Exception:
                        pass
                    return Response(content=data, media_type="image/jpeg")
        except Exception as e:
            logger.error(f"Error loading cover from source file: {e}")
            raise HTTPException(status_code=500, detail="Failed to load cover from file")

    # 3. If cover_file_id is a Telegram file_id
    if telegram.tg_client and not folder.cover_file_id.startswith("local:"):
        try:
            thumb_bytes = await telegram.tg_client.download_media(folder.cover_file_id, in_memory=True)
            data = thumb_bytes.getvalue()
            try:
                cover_path.write_bytes(data)
            except Exception:
                pass
            return Response(content=data, media_type="image/jpeg")
        except Exception as e:
            logger.error(f"Error downloading cover from Telegram: {e}")
            raise HTTPException(status_code=500, detail="Failed to load cover from Telegram")

    raise HTTPException(status_code=404, detail="Cover image file not found")


@router.post("/{folder_id}/cover", response_model=FolderResponse)
async def upload_folder_cover(
    folder_id: int,
    file: UploadFile = FastApiFile(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload a cover image for a folder."""
    result = await db.execute(
        select(Folder).where(Folder.id == folder_id, Folder.user_id == current_user.id)
    )
    folder = result.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
        
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    if len(contents) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Cover image must be under 10MB")
        
    # Save locally
    cover_path = get_cover_path(folder_id)
    cover_path.write_bytes(contents)
    
    file_id = f"local:{folder_id}"
    
    # Optionally upload to Telegram storage channel
    try:
        if telegram.tg_client and telegram.tg_client.is_connected:
            import io
            photo_io = io.BytesIO(contents)
            photo_io.name = "cover.jpg"
            msg = await telegram.tg_client.send_photo(
                chat_id=settings.telegram_storage_channel_id,
                photo=photo_io,
                caption=f"Folder Cover: {folder.name}"
            )
            if msg and msg.photo:
                file_id = msg.photo[-1].file_id
    except Exception as e:
        logger.warning(f"Could not forward folder cover to Telegram: {e}")
        
    folder.cover_file_id = file_id
    folder.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(folder)
    
    file_count = await get_folder_file_count(db, folder.id)
    return to_folder_response(folder, file_count)


@router.post("/{folder_id}/cover/from-file/{source_file_id}", response_model=FolderResponse)
async def set_folder_cover_from_file(
    folder_id: int,
    source_file_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Set folder cover image using an existing file from user library."""
    result = await db.execute(
        select(Folder).where(Folder.id == folder_id, Folder.user_id == current_user.id)
    )
    folder = result.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
        
    file_res = await db.execute(
        select(File).where(File.id == source_file_id, File.user_id == current_user.id)
    )
    source_file = file_res.scalar_one_or_none()
    if not source_file:
        raise HTTPException(status_code=404, detail="Source file not found")
        
    folder.cover_file_id = f"file:{source_file.id}"
    folder.updated_at = datetime.utcnow()
    
    # Try pre-caching image thumbnail locally
    try:
        if telegram.tg_client:
            message = await get_message_from_channel(source_file.channel_message_id)
            thumb = None
            if message:
                if message.video and message.video.thumbs:
                    thumb = message.video.thumbs[0]
                elif message.document and message.document.thumbs:
                    thumb = message.document.thumbs[0]
                elif message.audio and message.audio.thumbs:
                    thumb = message.audio.thumbs[0]
                elif message.photo:
                    thumb = message.photo[-1]
            if thumb:
                thumb_bytes = await telegram.tg_client.download_media(thumb.file_id, in_memory=True)
                cover_path = get_cover_path(folder_id)
                cover_path.write_bytes(thumb_bytes.getvalue())
    except Exception as e:
        logger.debug(f"Pre-caching cover failed: {e}")

    await db.commit()
    await db.refresh(folder)
    
    file_count = await get_folder_file_count(db, folder.id)
    return to_folder_response(folder, file_count)


@router.delete("/{folder_id}/cover", response_model=FolderResponse)
async def delete_folder_cover(
    folder_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Remove cover image from a folder."""
    result = await db.execute(
        select(Folder).where(Folder.id == folder_id, Folder.user_id == current_user.id)
    )
    folder = result.scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
        
    cover_path = get_cover_path(folder_id)
    if cover_path.exists():
        try:
            cover_path.unlink()
        except Exception:
            pass
            
    alt_path = Path("covers") / f"{folder_id}.jpg"
    if alt_path.exists():
        try:
            alt_path.unlink()
        except Exception:
            pass
            
    folder.cover_file_id = None
    folder.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(folder)
    
    file_count = await get_folder_file_count(db, folder.id)
    return to_folder_response(folder, file_count)


@router.post("", response_model=FolderResponse, status_code=201)
async def create_folder(
    folder_data: FolderCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new folder."""
    if folder_data.parent_id:
        parent_result = await db.execute(
            select(Folder).where(
                Folder.id == folder_data.parent_id,
                Folder.user_id == current_user.id
            )
        )
        if not parent_result.scalar_one_or_none():
            raise HTTPException(status_code=404, detail="Parent folder not found")
    
    existing = await db.execute(
        select(Folder).where(
            Folder.user_id == current_user.id,
            Folder.parent_id == folder_data.parent_id,
            Folder.name == folder_data.name
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Folder with this name already exists")
    
    folder = Folder(
        user_id=current_user.id,
        name=folder_data.name,
        parent_id=folder_data.parent_id,
    )
    db.add(folder)
    await db.commit()
    await db.refresh(folder)
    
    return to_folder_response(folder, 0)


@router.patch("/{folder_id}", response_model=FolderResponse)
async def update_folder(
    folder_id: int,
    update_data: FolderUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a folder (rename, move, cover)."""
    result = await db.execute(
        select(Folder).where(Folder.id == folder_id, Folder.user_id == current_user.id)
    )
    folder = result.scalar_one_or_none()
    
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    if update_data.name is not None:
        folder.name = update_data.name
    if update_data.parent_id is not None:
        if update_data.parent_id == folder_id:
            raise HTTPException(status_code=400, detail="Cannot move folder into itself")
        
        if update_data.parent_id != 0:
            parent_check = await db.execute(
                select(Folder).where(
                    Folder.id == update_data.parent_id,
                    Folder.user_id == current_user.id
                )
            )
            if not parent_check.scalar_one_or_none():
                raise HTTPException(status_code=404, detail="Parent folder not found")
        
        folder.parent_id = update_data.parent_id if update_data.parent_id != 0 else None

    if update_data.cover_file_id is not None:
        folder.cover_file_id = update_data.cover_file_id if update_data.cover_file_id != "" else None
    
    await db.commit()
    await db.refresh(folder)
    
    file_count = await get_folder_file_count(db, folder.id)
    return to_folder_response(folder, file_count)


@router.delete("/{folder_id}")
async def delete_folder(
    folder_id: int,
    move_files_to: Optional[int] = Query(None, description="Move files to this folder ID (null = root)"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a folder. Files can be moved to another folder or deleted."""
    result = await db.execute(
        select(Folder).where(Folder.id == folder_id, Folder.user_id == current_user.id)
    )
    folder = result.scalar_one_or_none()
    
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    # Delete local cover file if present
    try:
        cover_path = get_cover_path(folder_id)
        if cover_path.exists():
            cover_path.unlink()
        alt_path = Path("covers") / f"{folder_id}.jpg"
        if alt_path.exists():
            alt_path.unlink()
    except Exception:
        pass

    if move_files_to is not None:
        from sqlalchemy import update
        await db.execute(
            update(File)
            .where(File.folder_id == folder_id)
            .values(folder_id=move_files_to if move_files_to != 0 else None)
        )
    else:
        from sqlalchemy import text, delete
        query = text("""
            WITH RECURSIVE subfolders AS (
                SELECT id FROM folders WHERE id = :root_id
                UNION ALL
                SELECT f.id FROM folders f
                INNER JOIN subfolders sf ON f.parent_id = sf.id
            )
            SELECT id FROM subfolders
        """)
        result = await db.execute(query, {"root_id": folder_id})
        folder_ids = result.scalars().all()
        
        if folder_ids:
            file_query = select(File).where(File.folder_id.in_(folder_ids))
            file_result = await db.execute(file_query)
            files_to_delete = file_result.scalars().all()
            
            message_ids = [f.channel_message_id for f in files_to_delete if f.channel_message_id]
            if message_ids:
                chunk_size = 100
                for i in range(0, len(message_ids), chunk_size):
                    batch = message_ids[i:i + chunk_size]
                    await delete_from_storage_channel(batch)
            
            await db.execute(delete(File).where(File.folder_id.in_(folder_ids)))
    
    await db.delete(folder)
    await db.commit()
    
    return {"message": "Folder deleted successfully"}


@router.post("/batch-delete")
async def batch_delete_folders(
    folder_ids: List[int],
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete multiple folders."""
    result = await db.execute(
        select(Folder).where(Folder.id.in_(folder_ids), Folder.user_id == current_user.id)
    )
    folders = result.scalars().all()
    
    if not folders:
        return {"message": "No folders found to delete"}
    
    from sqlalchemy import text, delete as sqlalchemy_delete
    
    all_affected_folder_ids = []
    for folder in folders:
        query = text("""
            WITH RECURSIVE subfolders AS (
                SELECT id FROM folders WHERE id = :root_id
                UNION ALL
                SELECT f.id FROM folders f
                INNER JOIN subfolders sf ON f.parent_id = sf.id
            )
            SELECT id FROM subfolders
        """)
        folder_result = await db.execute(query, {"root_id": folder.id})
        all_affected_folder_ids.extend(folder_result.scalars().all())
    
    all_affected_folder_ids = list(set(all_affected_folder_ids))
    
    if all_affected_folder_ids:
        file_query = select(File).where(File.folder_id.in_(all_affected_folder_ids))
        file_result = await db.execute(file_query)
        files_to_delete = file_result.scalars().all()
        
        message_ids = [f.channel_message_id for f in files_to_delete if f.channel_message_id]
        if message_ids:
            await delete_from_storage_channel(message_ids)
        
        await db.execute(sqlalchemy_delete(File).where(File.folder_id.in_(all_affected_folder_ids)))
    
    for folder in folders:
        try:
            cover_path = get_cover_path(folder.id)
            if cover_path.exists():
                cover_path.unlink()
        except Exception:
            pass
        await db.delete(folder)
        
    await db.commit()
    return {"message": f"Deleted {len(folders)} folders and their content"}


@router.post("/batch-move")
async def batch_move_folders(
    move_data: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Move multiple folders to another folder."""
    folder_ids = move_data.get("ids", [])
    target_id = move_data.get("folder_id")
    
    if target_id == 0:
        target_id = None
        
    if target_id in folder_ids:
        raise HTTPException(status_code=400, detail="Cannot move a folder into itself")
        
    if target_id is not None:
        parent_check = await db.execute(
            select(Folder).where(Folder.id == target_id, Folder.user_id == current_user.id)
        )
        if not parent_check.scalar_one_or_none():
            raise HTTPException(status_code=404, detail="Target parent folder not found")
            
    from sqlalchemy import update
    await db.execute(
        update(Folder)
        .where(Folder.id.in_(folder_ids), Folder.user_id == current_user.id)
        .values(parent_id=target_id)
    )
    
    await db.commit()
    return {"message": f"Moved {len(folder_ids)} folders"}
