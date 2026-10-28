"""
Database setup with SQLAlchemy async support.
Supports both SQLite (for development) and PostgreSQL (for production).
"""
import logging
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.engine import make_url
from sqlalchemy import text
from .config import get_settings
from uuid import uuid4

logger = logging.getLogger(__name__)
settings = get_settings()

# Convert database URL for async drivers and handle query params
url = make_url(settings.database_url)

if url.drivername == "postgresql":
    url = url.set(drivername="postgresql+asyncpg")
    # Remove 'schema' from query params if present (asyncpg doesn't support it in connect args)
    if "schema" in url.query:
        query = dict(url.query)
        del query["schema"]
        url = url.set(query=query)
elif url.drivername == "sqlite":
    url = url.set(drivername="sqlite+aiosqlite")

engine = create_async_engine(
    url,
    echo=False,
    pool_pre_ping=True,
    pool_recycle=300,
    pool_size=3,
    max_overflow=2,
    connect_args={
        "statement_cache_size": 0,
        "prepared_statement_cache_size": 0,
        "prepared_statement_name_func": lambda: f"__asyncpg_{uuid4()}__",
    },
)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db():
    """Dependency for getting database session."""
    async with async_session() as session:
        try:
            yield session
        finally:
            await session.close()


async def init_db():
    """Create all tables and run lightweight migrations."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        
        # Safe migration for cover_file_id column if table already exists
        try:
            if engine.dialect.name == "sqlite":
                result = await conn.execute(text("PRAGMA table_info(folders)"))
                cols = [row[1] for row in result.fetchall()]
                if "cover_file_id" not in cols:
                    await conn.execute(text("ALTER TABLE folders ADD COLUMN cover_file_id VARCHAR(255)"))
            else:
                await conn.execute(text("ALTER TABLE folders ADD COLUMN IF NOT EXISTS cover_file_id VARCHAR(255)"))
        except Exception as e:
            logger.debug(f"Column migration check for cover_file_id: {e}")
