from __future__ import annotations

import io
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from .converter import ConversionError, convert_uploads

APP_NAME = "Brightspace Self-Assessment to Question Library Converter"
OUTPUT_NAME = "Brightspace_QuestionLibrary_Migration.zip"
REPO_ROOT = Path(__file__).resolve().parents[1]

app = FastAPI(
    title=APP_NAME,
    version="0.2.0",
)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": APP_NAME}


@app.get("/api/capabilities")
async def capabilities() -> dict:
    """
    Makes the current integration boundary explicit to the UI.

    The server-side converter and documented Brightspace package-import API
    are available. Direct Self-Assessment discovery is intentionally marked
    unavailable until we have a supported Brightspace source mechanism.
    """
    return {
        "serverConversion": True,
        "brightspacePackageImport": True,
        "ltiCourseContext": "planned",
        "directSelfAssessmentDiscovery": False,
    }


@app.post("/api/convert")
async def convert(files: list[UploadFile] = File(...)):
    if not files:
        raise HTTPException(status_code=400, detail="No files were supplied.")

    uploads: list[tuple[str, bytes]] = []
    for upload in files:
        name = upload.filename or "upload"
        data = await upload.read()
        if not data:
            raise HTTPException(
                status_code=400,
                detail=f"{name} is empty.",
            )
        uploads.append((name, data))

    try:
        result = convert_uploads(uploads)
    except ConversionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    headers = {
        "Content-Disposition": f'attachment; filename="{OUTPUT_NAME}"',
        "X-SAQL-Assessment-Count": str(len(result.report)),
        "X-SAQL-Question-Count": str(
            sum(item["questionCount"] for item in result.report)
        ),
    }

    return StreamingResponse(
        io.BytesIO(result.package_bytes),
        media_type="application/zip",
        headers=headers,
    )


# During the transition from GitHub Pages, serve the existing front end from
# explicit paths. This avoids exposing the server source directory.
@app.get("/")
async def index():
    return FileResponse(REPO_ROOT / "index.html")


@app.get("/index.html")
async def index_html():
    return FileResponse(REPO_ROOT / "index.html")


@app.get("/style.css")
async def style():
    return FileResponse(REPO_ROOT / "style.css", media_type="text/css")


@app.get("/script.js")
async def script():
    return FileResponse(
        REPO_ROOT / "script.js",
        media_type="application/javascript",
    )


@app.exception_handler(ConversionError)
async def conversion_error_handler(_, exc: ConversionError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})
