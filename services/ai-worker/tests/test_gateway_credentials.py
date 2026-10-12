"""The worker's identity on our own media gateway (review item S3).

MediaMTX no longer lets anyone read a path anonymously: it asks the API, which
admits the ANPR workers by MEDIAMTX_READ_USER/_PASSWORD. The worker adds that
identity to the URLs of its own gateway's cameras, and to nothing else — a
federated camera's URL names somebody else's host and must never be handed
our password.
"""

from __future__ import annotations

from ai_worker.discovery import CameraStream, with_gateway_credentials

HOSTS = frozenset({"mediamtx", "localhost"})


def stream(url: str) -> CameraStream:
    return CameraStream(camera_code="CAM-DEMO-01", rtsp_url=url)


def test_our_gateway_gets_the_reader_identity() -> None:
    out = with_gateway_credentials(
        stream("rtsp://mediamtx:8554/cam-demo-01"),
        HOSTS,
        "contrail-reader",
        "s3cret_-x",
    )
    assert out.rtsp_url == "rtsp://contrail-reader:s3cret_-x@mediamtx:8554/cam-demo-01"
    assert out.camera_code == "CAM-DEMO-01"


def test_a_federated_camera_never_gets_our_password() -> None:
    grid = "rtsp://103.250.160.189:8554/stream/cam10"
    assert with_gateway_credentials(stream(grid), HOSTS, "u", "p").rtsp_url == grid


def test_credentials_already_in_the_url_are_kept() -> None:
    url = "rtsp://someone:else@mediamtx:8554/cam-demo-01"
    assert with_gateway_credentials(stream(url), HOSTS, "u", "p").rtsp_url == url


def test_no_password_configured_leaves_the_url_alone() -> None:
    url = "rtsp://mediamtx:8554/cam-demo-01"
    assert with_gateway_credentials(stream(url), HOSTS, "u", "").rtsp_url == url


def test_hls_urls_are_not_touched() -> None:
    url = "http://mediamtx:8888/cam-demo-01/index.m3u8"
    assert with_gateway_credentials(stream(url), HOSTS, "u", "p").rtsp_url == url


def test_special_characters_are_escaped() -> None:
    out = with_gateway_credentials(
        stream("rtsp://localhost:8554/x"), HOSTS, "u", "p@ss:w/rd"
    )
    assert out.rtsp_url == "rtsp://u:p%40ss%3Aw%2Frd@localhost:8554/x"
