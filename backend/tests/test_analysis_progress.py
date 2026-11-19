import asyncio
from importlib.util import find_spec
from threading import Event

from fastapi.testclient import TestClient
import pytest


@pytest.fixture
def analysis_app(monkeypatch):
    monkeypatch.setenv("CREATEAI_SERVICE_TOKEN", "test-token")
    monkeypatch.setenv("S2_API_KEY", "test-key")
    from CITation import main

    return main


@pytest.fixture
def client(analysis_app):
    with TestClient(
        analysis_app.app, backend_options={"use_uvloop": find_spec("uvloop") is not None}
    ) as test_client:
        yield test_client


def send_paper(socket):
    socket.send_json({"title": "Manuscript", "authors": ["A. Reader"], "year": "2025"})
    socket.send_json({"mime_type": "application/pdf"})
    socket.send_bytes(b"test PDF")


def test_progress_arrives_while_analysis_worker_is_running(analysis_app, client, monkeypatch):
    release_worker = Event()

    async def analyze(paper_metadata, pdf, progress):
        def work():
            progress("progress", "Looking up reference 1 of 3.")
            assert release_worker.wait(5), "Progress did not reach the WebSocket"
            progress("warning", "Some cited papers are missing abstracts.")
            return {"citations": []}

        return await asyncio.to_thread(work)

    monkeypatch.setattr(analysis_app, "analyze_pdf", analyze)
    with client.websocket_connect("/ws/process_pdf") as socket:
        send_paper(socket)
        assert socket.receive_json()["msg"] == "Looking up reference 1 of 3."
        release_worker.set()
        assert socket.receive_json()["type"] == "warning"
        assert socket.receive_json() == {"type": "end", "results": {"citations": []}}


def test_analysis_failure_is_reported_over_the_websocket(analysis_app, client, monkeypatch):
    async def analyze(paper_metadata, pdf, progress):
        progress("info", "Checking the PDF…")
        raise ValueError("Internal error details")

    monkeypatch.setattr(analysis_app, "analyze_pdf", analyze)
    with client.websocket_connect("/ws/process_pdf") as socket:
        send_paper(socket)
        assert socket.receive_json()["type"] == "info"
        error = socket.receive_json()
        assert error["type"] == "error"
        assert error["msg"] == "Analysis failed. Please try again."
