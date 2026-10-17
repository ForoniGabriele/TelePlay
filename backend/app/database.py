"""
Database setup with SQLAlchemy async support.
Supports both SQLite (for development) and PostgreSQL (for production).
"""
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.engine import make_url
from .config import get_settings

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
    pool_recycle=300,   # Recycle connections every 5 minutes
    pool_size=3,        # Supabase free: max 15 clients in session mode
    max_overflow=2,     # At most 5 connections in total
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
    """Create all tables."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
