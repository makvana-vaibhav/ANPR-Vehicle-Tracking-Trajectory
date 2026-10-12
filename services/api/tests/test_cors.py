"""Cross-origin headers the web app depends on.

The command centre calls the API from another origin, so a response header
it reads must be listed in Access-Control-Expose-Headers or the browser hides
it. Content-Disposition carries an export's filename; without it every CSV
saved as "export.csv".
"""

from httpx import AsyncClient

from app.core.config import get_settings


async def test_exports_expose_their_filename_cross_origin(client: AsyncClient) -> None:
    origin = get_settings().cors_origin_list[0]
    response = await client.get("/health", headers={"Origin": origin})
    exposed = response.headers.get("access-control-expose-headers", "").lower()
    assert "content-disposition" in exposed
    assert "x-request-id" in exposed
