from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx
import jwt
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer


LTI_CONTEXT_CLAIM = "https://purl.imsglobal.org/spec/lti/claim/context"
LTI_DEPLOYMENT_CLAIM = "https://purl.imsglobal.org/spec/lti/claim/deployment_id"
LTI_MESSAGE_TYPE_CLAIM = "https://purl.imsglobal.org/spec/lti/claim/message_type"
LTI_VERSION_CLAIM = "https://purl.imsglobal.org/spec/lti/claim/version"
LTI_CUSTOM_CLAIM = "https://purl.imsglobal.org/spec/lti/claim/custom"


class LtiConfigurationError(RuntimeError):
    pass


class LtiLaunchError(RuntimeError):
    pass


@dataclass(slots=True)
class LtiLaunchContext:
    issuer: str
    subject: str
    name: str
    roles: list[str]
    context_id: str
    context_title: str
    deployment_id: str
    message_type: str
    lti_version: str
    custom: dict

    @property
    def possible_org_unit_id(self) -> str | None:
        """
        Return an explicitly supplied org-unit ID custom parameter when one is
        present. Do not assume the standard LTI context ID is always the same
        thing as Brightspace's numeric org-unit ID.
        """
        for key in (
            "org_unit_id",
            "orgUnitId",
            "orgunitid",
            "course_org_unit_id",
        ):
            value = self.custom.get(key)
            if value is not None and str(value).strip():
                return str(value).strip()
        return None


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise LtiConfigurationError(f"{name} is not configured.")
    return value


def _state_serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(
        _required_env("LTI_STATE_SECRET"),
        salt="saql-lti-state",
    )


def _launch_url() -> str:
    return f"{_required_env('APP_BASE_URL').rstrip('/')}/lti/launch"


def create_login_redirect(params: dict[str, str]) -> str:
    """
    Create the OIDC authentication redirect for an LTI 1.3 launch.

    Brightspace initiates this endpoint with iss/login_hint and optionally
    lti_message_hint. The tool redirects to Brightspace's authentication
    endpoint and receives the signed id_token at /lti/launch.
    """
    issuer = (params.get("iss") or "").strip()
    configured_issuer = _required_env("LTI_ISSUER")
    if issuer != configured_issuer:
        raise LtiLaunchError(
            f"Unexpected LTI issuer: {issuer or '[missing]'}."
        )

    login_hint = (params.get("login_hint") or "").strip()
    if not login_hint:
        raise LtiLaunchError("LTI login_hint is missing.")

    client_id = (params.get("client_id") or "").strip()
    configured_client_id = _required_env("LTI_CLIENT_ID")
    if client_id and client_id != configured_client_id:
        raise LtiLaunchError("Unexpected LTI client_id.")

    nonce = secrets.token_urlsafe(32)
    state = _state_serializer().dumps(
        {
            "nonce": nonce,
            "issuer": issuer,
        }
    )

    query = {
        "scope": "openid",
        "response_type": "id_token",
        "response_mode": "form_post",
        "prompt": "none",
        "client_id": configured_client_id,
        "redirect_uri": _launch_url(),
        "login_hint": login_hint,
        "state": state,
        "nonce": nonce,
    }

    message_hint = (params.get("lti_message_hint") or "").strip()
    if message_hint:
        query["lti_message_hint"] = message_hint

    target_link_uri = (params.get("target_link_uri") or "").strip()
    if target_link_uri:
        query["target_link_uri"] = target_link_uri

    auth_url = _required_env("LTI_PLATFORM_AUTH_URL")
    separator = "&" if "?" in auth_url else "?"
    return f"{auth_url}{separator}{urlencode(query)}"


async def validate_launch(
    id_token: str,
    state: str,
) -> LtiLaunchContext:
    try:
        state_data = _state_serializer().loads(state, max_age=600)
    except SignatureExpired as exc:
        raise LtiLaunchError(
            "The LTI launch state expired. Launch the tool again from Brightspace."
        ) from exc
    except BadSignature as exc:
        raise LtiLaunchError("The LTI launch state is invalid.") from exc

    expected_nonce = state_data.get("nonce")
    expected_issuer = state_data.get("issuer")
    if not expected_nonce or not expected_issuer:
        raise LtiLaunchError("The LTI launch state is incomplete.")

    configured_issuer = _required_env("LTI_ISSUER")
    if expected_issuer != configured_issuer:
        raise LtiLaunchError("The LTI issuer changed during launch.")

    try:
        header = jwt.get_unverified_header(id_token)
    except jwt.PyJWTError as exc:
        raise LtiLaunchError("The LTI id_token header is invalid.") from exc

    kid = header.get("kid")
    if not kid:
        raise LtiLaunchError("The LTI id_token does not contain a key ID.")

    jwks_url = _required_env("LTI_PLATFORM_JWKS_URL")
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.get(jwks_url)

    if response.status_code != 200:
        raise LtiLaunchError(
            f"Unable to retrieve Brightspace JWKS ({response.status_code})."
        )

    try:
        jwks = response.json()
        jwk = next(
            key
            for key in jwks.get("keys", [])
            if key.get("kid") == kid
        )
    except (ValueError, StopIteration) as exc:
        raise LtiLaunchError(
            "Brightspace JWKS does not contain the signing key for this launch."
        ) from exc

    try:
        public_key = jwt.algorithms.RSAAlgorithm.from_jwk(jwk)
        claims = jwt.decode(
            id_token,
            key=public_key,
            algorithms=["RS256"],
            audience=_required_env("LTI_CLIENT_ID"),
            issuer=configured_issuer,
            options={
                "require": [
                    "iss",
                    "sub",
                    "aud",
                    "exp",
                    "iat",
                    "nonce",
                ]
            },
        )
    except jwt.PyJWTError as exc:
        raise LtiLaunchError(
            f"The Brightspace LTI id_token could not be validated: {exc}"
        ) from exc

    if claims.get("nonce") != expected_nonce:
        raise LtiLaunchError("The LTI nonce does not match the login request.")

    deployment_id = str(claims.get(LTI_DEPLOYMENT_CLAIM, "")).strip()
    configured_deployment = os.getenv("LTI_DEPLOYMENT_ID", "").strip()
    if configured_deployment and deployment_id != configured_deployment:
        raise LtiLaunchError("Unexpected LTI deployment ID.")

    message_type = str(claims.get(LTI_MESSAGE_TYPE_CLAIM, "")).strip()
    if message_type and message_type != "LtiResourceLinkRequest":
        raise LtiLaunchError(
            f"Unsupported LTI message type: {message_type}."
        )

    context = claims.get(LTI_CONTEXT_CLAIM) or {}
    if not isinstance(context, dict):
        context = {}

    custom = claims.get(LTI_CUSTOM_CLAIM) or {}
    if not isinstance(custom, dict):
        custom = {}

    roles = claims.get(
        "https://purl.imsglobal.org/spec/lti/claim/roles",
        [],
    )
    if not isinstance(roles, list):
        roles = [str(roles)]

    name = (
        str(claims.get("name") or "").strip()
        or "Brightspace user"
    )

    return LtiLaunchContext(
        issuer=str(claims.get("iss", "")),
        subject=str(claims.get("sub", "")),
        name=name,
        roles=[str(role) for role in roles],
        context_id=str(context.get("id", "")),
        context_title=str(
            context.get("title")
            or context.get("label")
            or "Brightspace course"
        ),
        deployment_id=deployment_id,
        message_type=message_type,
        lti_version=str(claims.get(LTI_VERSION_CLAIM, "")),
        custom=custom,
    )
