from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx


class BrightspaceApiError(RuntimeError):
    """Raised when a Brightspace API request fails."""


@dataclass(slots=True)
class BrightspaceClient:
    """
    Small Brightspace API client for the integration steps we can support
    through documented APIs.

    Authentication is deliberately injected. The LTI/OAuth layer will obtain
    and refresh the bearer token; this client only consumes it.
    """

    base_url: str
    le_version: str
    access_token: str

    def _url(self, path: str) -> str:
        return f"{self.base_url.rstrip('/')}{path}"

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access_token}"}

    async def import_question_library_package(
        self,
        org_unit_id: int | str,
        package_bytes: bytes,
        filename: str = "Brightspace_QuestionLibrary_Migration.zip",
    ) -> dict[str, Any]:
        """
        Submit the generated Question Library package to a course import job.

        Brightspace route:
        POST /d2l/api/le/{version}/import/{orgUnitId}/imports/

        Required OAuth2 scope documented by D2L:
        import:job:create
        """
        if not self.le_version:
            raise BrightspaceApiError("BRIGHTSPACE_LE_VERSION is not configured.")

        url = self._url(
            f"/d2l/api/le/{self.le_version}/import/{org_unit_id}/imports/"
        )

        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                url,
                headers=self._headers(),
                files={
                    "file": (
                        filename,
                        package_bytes,
                        "application/zip",
                    )
                },
            )

        if response.status_code != 202:
            raise BrightspaceApiError(
                f"Brightspace import request failed "
                f"({response.status_code}): {response.text[:1000]}"
            )

        try:
            return response.json()
        except ValueError:
            return {"status_code": response.status_code, "body": response.text}

    async def get_import_job(
        self,
        org_unit_id: int | str,
        job_token: str,
    ) -> dict[str, Any]:
        """
        Retrieve a queued import job.

        Brightspace route:
        GET /d2l/api/le/{version}/import/{orgUnitId}/imports/{jobToken}

        Required OAuth2 scope documented by D2L:
        import:job:fetch
        """
        if not self.le_version:
            raise BrightspaceApiError("BRIGHTSPACE_LE_VERSION is not configured.")

        url = self._url(
            f"/d2l/api/le/{self.le_version}/import/"
            f"{org_unit_id}/imports/{job_token}"
        )

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(url, headers=self._headers())

        if response.status_code != 200:
            raise BrightspaceApiError(
                f"Brightspace import status request failed "
                f"({response.status_code}): {response.text[:1000]}"
            )

        return response.json()
