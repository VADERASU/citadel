import json
from types import SimpleNamespace

import pytest

from CITation import cache, llm


@pytest.fixture(autouse=True)
def isolated_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(cache, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(cache, "ENABLED", True)
    monkeypatch.setattr(cache, "_throttles", {})
    cache.reset_stats()


@pytest.fixture
def http_clock(monkeypatch):
    clock = SimpleNamespace(now=0.0)

    def sleep(seconds):
        clock.now += seconds

    monkeypatch.setattr(cache, "time", SimpleNamespace(
        monotonic=lambda: clock.now,
        sleep=sleep,
        time=lambda: 1_700_000_000 + clock.now,
    ))
    return clock


class FakeHTTP:
    """Stands in for requests.request; records every network call."""

    def __init__(self, status=200, body_fn=None):
        self.calls = []
        self.status = status
        self.body_fn = body_fn or (lambda **kw: {"ok": True})

    def __call__(self, method, url, **kw):
        self.calls.append({"method": method, "url": url, **kw})
        return SimpleNamespace(
            status_code=self.status,
            text=json.dumps(self.body_fn(**kw)),
            headers={"content-type": "application/json"},
        )


def test_make_key_hashes_bytes_by_content_and_ignores_dict_order():
    assert cache.make_key(b"pdf", {"a": 1, "b": 2}) == cache.make_key(
        bytes(b"pdf"), {"b": 2, "a": 1}
    )
    assert cache.make_key(b"pdf") != cache.make_key(b"other pdf")


def test_get_put_roundtrip_distinguishes_cached_none_and_expires(monkeypatch):
    assert cache.get("ns", "k") is cache.MISSING
    cache.put("ns", "k", None)
    assert cache.get("ns", "k") is None

    now = cache.time.time()
    monkeypatch.setattr(cache.time, "time", lambda: now + 100)
    assert cache.get("ns", "k", max_age=1000) is None
    assert cache.get("ns", "k", max_age=10) is cache.MISSING
    assert cache.stats()["ns"] == {"hits": 2, "misses": 2}


def test_disabled_cache_never_hits(monkeypatch):
    cache.put("ns", "k", 1)
    monkeypatch.setattr(cache, "ENABLED", False)
    assert cache.get("ns", "k") is cache.MISSING


def test_request_caches_success_and_ignores_headers(monkeypatch):
    http = FakeHTTP()
    monkeypatch.setattr(cache.requests, "request", http)
    pdf = {"input": ("paper.pdf", b"%PDF-1.4 ...", "application/pdf")}

    r1 = cache.request("t", "POST", "http://x/api", files=pdf, headers={"x-api-key": "a"})
    r2 = cache.request("t", "POST", "http://x/api", files=pdf, headers={"x-api-key": "b"})
    assert r1.json() == r2.json() == {"ok": True}
    assert len(http.calls) == 1

    other_pdf = {"input": ("paper.pdf", b"%PDF-1.4 other", "application/pdf")}
    cache.request("t", "POST", "http://x/api", files=other_pdf)
    assert len(http.calls) == 2


def test_request_does_not_cache_failures_or_uncached_namespace(monkeypatch):
    http = FakeHTTP(status=503)
    monkeypatch.setattr(cache.requests, "request", http)
    r = cache.request("t", "GET", "http://x/api")
    with pytest.raises(cache.requests.HTTPError):
        r.raise_for_status()
    cache.request("t", "GET", "http://x/api")
    assert len(http.calls) == 2

    http.status = 200
    cache.request(None, "GET", "http://x/api")
    cache.request(None, "GET", "http://x/api")
    assert len(http.calls) == 4


def test_llm_chat_caches_replies_but_not_empty_ones(monkeypatch):
    monkeypatch.setattr(
        llm, "_model_info_cache", {"m": {"supported": {"max_tokens"}, "reasoning": False}}
    )
    replies = iter(["", "Score: 7", "unused"])
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        msg = SimpleNamespace(content=next(replies))
        return SimpleNamespace(choices=[SimpleNamespace(message=msg)])

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    msgs = [{"role": "user", "content": "rate this"}]

    assert llm.chat(client, model="m", messages=msgs, temperature=0.2) == ""
    assert llm.chat(client, model="m", messages=msgs, temperature=0.2) == "Score: 7"
    assert llm.chat(client, model="m", messages=msgs, temperature=0.2) == "Score: 7"
    assert len(calls) == 2
    assert "temperature" not in calls[0]  # unsupported param dropped before keying

    llm.chat(client, model="m", messages=[{"role": "user", "content": "changed"}])
    assert len(calls) == 3


def test_s2_batch_caches_per_paper_across_batches(monkeypatch, http_clock):
    from CITation.data.raw_ref_to_json import PaperProcessor

    monkeypatch.setenv("S2_API_KEY", "test")
    http = FakeHTTP(
        body_fn=lambda data, **kw: [
            None if pid == "missing" else {"paperId": pid}
            for pid in json.loads(data)["ids"]
        ]
    )
    monkeypatch.setattr(cache.requests, "request", http)
    proc = PaperProcessor(request_delay=0)

    assert proc._s2_batch(["a", "b"], "title") == [{"paperId": "a"}, {"paperId": "b"}]
    result = proc._s2_batch(["b", "missing", "c"], "title")
    assert result == [{"paperId": "b"}, None, {"paperId": "c"}]
    assert [json.loads(c["data"])["ids"] for c in http.calls] == [
        ["a", "b"],
        ["missing", "c"],
    ]

    # Not-found papers are cached too; different fields are a separate entry.
    proc._s2_batch(["missing"], "title")
    assert len(http.calls) == 2
    proc._s2_batch(["a"], "title,year")
    assert len(http.calls) == 3
    assert http_clock.now == 2


def test_s2_title_and_detail_requests_share_throttle_and_use_cache(monkeypatch, http_clock):
    from CITation.data.raw_ref_to_json import PaperProcessor

    monkeypatch.setenv("S2_API_KEY", "test")
    network_times = []

    def send(method, url, **kwargs):
        network_times.append(http_clock.now)
        body = {"data": [{"paperId": "a"}]} if url.endswith("/match") else {"paperId": "a"}
        return SimpleNamespace(status_code=200, text=json.dumps(body), headers={})

    monkeypatch.setattr(cache.requests, "request", send)
    assert PaperProcessor().search_paper("Example") == "a"
    assert PaperProcessor().get_paper_details("a")["paperId"] == "a"
    assert PaperProcessor().search_paper("Example") == "a"
    assert network_times == [0, 1]


@pytest.mark.parametrize(("retry_after", "wait"), [
    ({}, 2),
    ({"retry-after": "5"}, 5),
    ({"Retry-After": "Tue, 14 Nov 2023 22:13:25 GMT"}, 5),
])
def test_s2_title_search_retries_rate_limits_and_caches_404(monkeypatch, http_clock, retry_after, wait):
    from CITation.data.raw_ref_to_json import PaperProcessor

    monkeypatch.setenv("S2_API_KEY", "test")
    statuses = iter([429, 200, 404])
    network_times = []

    def send(*args, **kwargs):
        network_times.append(http_clock.now)
        return SimpleNamespace(
            status_code=next(statuses),
            text='{"data": [{"paperId": "a"}]}',
            headers=retry_after,
        )

    monkeypatch.setattr(cache.requests, "request", send)
    proc = PaperProcessor()
    assert proc.search_paper("Found") == "a"
    assert not proc.s2_rate_limited
    assert proc.search_paper("Missing") is None
    assert proc.search_paper("Missing") is None
    assert network_times == [0, wait, wait + 1]


def test_s2_long_cooldown_keeps_cached_batch_results(monkeypatch, http_clock):
    from CITation.data.raw_ref_to_json import PaperProcessor

    monkeypatch.setenv("S2_API_KEY", "test")
    statuses = iter([200, 429, 200])
    network_times = []

    def send(*args, data, **kwargs):
        network_times.append(http_clock.now)
        return SimpleNamespace(
            status_code=next(statuses),
            text=json.dumps([{"paperId": pid} for pid in json.loads(data)["ids"]]),
            headers={"Retry-After": "60"},
        )

    monkeypatch.setattr(cache.requests, "request", send)
    proc = PaperProcessor()
    assert proc._s2_batch(["cached"], "title") == [{"paperId": "cached"}]
    assert proc._s2_batch(["cached", "uncached"], "title") == [{"paperId": "cached"}, None]
    assert proc.s2_rate_limited
    assert PaperProcessor().search_paper("A different request") is None
    assert network_times == [0, 1]

    http_clock.now = 61
    assert proc._s2_batch(["uncached"], "title") == [{"paperId": "uncached"}]
    assert network_times == [0, 1, 61]


def test_s2_repeated_429s_pause_uncached_requests(monkeypatch, http_clock):
    from CITation.data.raw_ref_to_json import PaperProcessor

    monkeypatch.setenv("S2_API_KEY", "test")
    network_times = []

    def send(*args, **kwargs):
        network_times.append(http_clock.now)
        return SimpleNamespace(status_code=429, text="", headers={})

    monkeypatch.setattr(cache.requests, "request", send)
    assert PaperProcessor().get_paper_details("a") is None
    proc = PaperProcessor()
    assert proc.search_paper("Example") is None
    assert proc.s2_rate_limited
    assert network_times == [0, 2, 6]


def test_secret_params_are_sent_but_not_part_of_the_key(monkeypatch):
    http = FakeHTTP()
    monkeypatch.setattr(cache.requests, "request", http)

    cache.request("ns", "GET", "https://x.test/a", params={"q": 1}, secret_params={"api_key": "k1"})
    cache.request("ns", "GET", "https://x.test/a", params={"q": 1}, secret_params={"api_key": "k2"})

    assert len(http.calls) == 1
    assert http.calls[0]["params"] == {"q": 1, "api_key": "k1"}


def _openalex_processor(monkeypatch, http, key=None):
    from CITation.data.raw_ref_to_json import PaperProcessor

    monkeypatch.setenv("S2_API_KEY", "test")
    if key:
        monkeypatch.setenv("OPENALEX_API_KEY", key)
    else:
        monkeypatch.delenv("OPENALEX_API_KEY", raising=False)
    monkeypatch.setattr(cache.requests, "request", http)
    return PaperProcessor(request_delay=0)


def test_openalex_429_skips_openalex_for_rest_of_run(monkeypatch):
    http = FakeHTTP(status=429, body_fn=lambda **kw: {"error": "Insufficient budget"})
    proc = _openalex_processor(monkeypatch, http)

    assert proc.retry_api_call(proc.get_openalex_work_details, ["W1", "W2"]) is None
    assert proc.get_paper_details_openalex("Some title") is None
    assert len(http.calls) == 1  # no retries, no further OpenAlex calls

    # A new run (new processor) tries again.
    proc2 = _openalex_processor(monkeypatch, http)
    proc2.get_paper_details_openalex("Some title")
    assert len(http.calls) == 2


def test_openalex_api_key_is_sent(monkeypatch):
    http = FakeHTTP(body_fn=lambda **kw: {"results": []})
    proc = _openalex_processor(monkeypatch, http, key="secret")

    proc.get_paper_details_openalex("Some title")
    assert http.calls[0]["params"]["api_key"] == "secret"


def test_openalex_second_hop_chunks_do_not_overlap(monkeypatch):
    from CITation.data import raw_ref_to_json as r2j

    def body(params, **kw):
        ids = params["filter"].removeprefix("ids.openalex:").split("|")
        return {"results": [{"id": f"https://openalex.org/{i}", "title": i} for i in ids]}

    http = FakeHTTP(body_fn=body)
    proc = _openalex_processor(monkeypatch, http)
    monkeypatch.setattr(r2j, "OPENALEX_CHUNK_SIZE", 3)
    refs = [f"https://openalex.org/W{i}" for i in range(7)]

    out = proc.process_second_hops(
        {"is_artificial": False, "references": refs, "ref_source": "openalex", "title": "P"}
    )

    sent = [c["params"]["filter"].removeprefix("ids.openalex:").split("|") for c in http.calls]
    assert sent == [["W0", "W1", "W2"], ["W3", "W4", "W5"], ["W6"]]
    assert [c["params"]["per-page"] for c in http.calls] == [3, 3, 1]
    assert [r["title"] for r in out] == [f"W{i}" for i in range(7)]
