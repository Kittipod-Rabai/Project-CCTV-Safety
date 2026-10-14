"""Static checks of the mockup UI (no Node in this environment): Upload & Analyze view wiring,
mock-data banners and the analyze.js data rules."""

from __future__ import annotations

import re
from html.parser import HTMLParser

import pytest

from conftest import REPO_ROOT

MOCKUP = REPO_ROOT / "mockup"
INDEX = MOCKUP / "index.html"
ANALYZE_JS = MOCKUP / "analyze.js"
LIVE_JS = MOCKUP / "live.js"
MOCK_TEXT = "ข้อมูลจำลอง"
REAL_BADGE_TEXT = "ผลจากโมเดลจริง — pilot"
ALLOWED_API = {"/api/health", "/api/stage1/analyze", "/api/stage2/analyze", "/api/pipeline/analyze",
               "/api/live/start", "/api/live/start-upload", "/api/live/stop", "/api/live/status", "/api/live/events"}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
        "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "use", "stop"}


class _Element:
    def __init__(self, tag, attrs):
        self.tag, self.attrs, self.children, self.text = tag, dict(attrs), [], []
        self.parent = None

    def all_text(self):
        return "".join(self.text) + "".join(c.all_text() for c in self.children)

    def iter(self):
        yield self
        for c in self.children:
            yield from c.iter()


class _TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Element("#root", [])
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = _Element(tag, attrs)
        node.parent = self.stack[-1]
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        node = _Element(tag, attrs)
        node.parent = self.stack[-1]
        self.stack[-1].children.append(node)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        if self.stack[-1].tag not in ("script", "style"):
            self.stack[-1].text.append(data)


@pytest.fixture(scope="module")
def html_text():
    return INDEX.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def tree(html_text):
    builder = _TreeBuilder()
    builder.feed(html_text)
    return builder.root


@pytest.fixture(scope="module")
def js_text():
    assert ANALYZE_JS.is_file(), "mockup/analyze.js is missing"
    return ANALYZE_JS.read_text(encoding="utf-8")


def by_id(tree, element_id):
    for node in tree.iter():
        if node.attrs.get("id") == element_id:
            return node
    raise AssertionError(f"no element with id={element_id!r} in mockup/index.html")


def _strip_js_comments(js: str) -> str:
    js = re.sub(r"/\*.*?\*/", "", js, flags=re.S)
    return re.sub(r"(^|[^:'\"`\\])//[^\n]*", r"\1", js)


# ---------------- index.html ----------------
def test_analyze_view_exists(tree):
    view = by_id(tree, "v-analyze")
    assert "view" in view.attrs.get("class", "").split()


def test_analyze_nav_item_exists(tree):
    items = [n for n in tree.iter() if n.attrs.get("data-go") == "analyze"]
    assert items, "no nav item with data-go=\"analyze\""
    assert any("nav-item" in n.attrs.get("class", "").split() for n in items)


def test_index_loads_analyze_js(tree):
    srcs = [n.attrs.get("src", "") for n in tree.iter() if n.tag == "script"]
    assert any(s.split("?")[0].rsplit("/", 1)[-1] == "analyze.js" for s in srcs), srcs


@pytest.mark.parametrize("view_id", ["v-live"])
def test_mock_views_show_mock_data_banner(tree, view_id):
    assert MOCK_TEXT in by_id(tree, view_id).all_text()


def test_history_view_uses_real_api_without_mock_rows(tree):
    view = by_id(tree, "v-logs")
    assert "ประวัติผลจากโมเดลจริง" in view.all_text()
    assert "ไม่ใช่เหตุที่ยืนยันแล้ว" in view.all_text()
    assert by_id(tree, "rlBody").children == []
    script = (MOCKUP / "logs.js").read_text(encoding="utf-8")
    assert "Math.random" not in script and "innerHTML" not in script
    assert "/api/logs" in script and "method:'PATCH'" in script


def test_real_model_badge_is_inside_analyze_view_and_hidden_by_default(tree):
    view = by_id(tree, "v-analyze")
    badges = [n for n in view.iter() if REAL_BADGE_TEXT in "".join(n.text)]
    assert len(badges) >= 2, "expected a real-model badge per stage (Stage 1 and Stage 2) in the analyze view"
    assert all("hidden" in b.attrs for b in badges), "real-model badge must start hidden until a real response"
    for view_id in ("v-dashboard", "v-live", "v-logs"):
        mock_view = by_id(tree, view_id)
        assert not any(REAL_BADGE_TEXT in "".join(n.text) for n in mock_view.iter())


def test_topbar_chip_makes_no_result_claim(tree):
    # The always-visible page chip is not tied to a response, so it must not claim real model output;
    # only the per-stage badges (gated on is_model_output) may say so.
    topbars = [n for n in tree.iter() if n.tag == "header" or "topbar" in n.attrs.get("class", "").split()]
    assert topbars, "no topbar/header found"
    for bar in topbars:
        text = bar.all_text()
        assert "ผลจากโมเดลจริง" not in text, text
        assert "REAL API" not in text.upper(), text
    for node in tree.iter():
        classes = node.attrs.get("class", "").split()
        if any(c.startswith("chip") for c in classes):
            assert "ผลจากโมเดลจริง" not in node.all_text()
            assert "REAL API" not in node.all_text().upper()


@pytest.mark.parametrize("sink", ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"])
def test_analyze_js_has_no_html_injection_sinks(js_text, sink):
    assert sink not in _strip_js_comments(js_text), f"analyze.js uses {sink}"


# ---------------- analyze.js ----------------
def test_analyze_js_has_no_random(js_text):
    assert "Math.random" not in js_text
    assert "crypto.getRandomValues" not in js_text


@pytest.mark.parametrize("name", ["LOGS", "SCENES", "CAMS", "CLS"])
def test_analyze_js_does_not_use_mock_data(js_text, name):
    assert not re.search(rf"\b{name}\b", _strip_js_comments(js_text)), f"analyze.js references mock {name}"


def test_analyze_js_calls_only_contract_endpoints(js_text):
    code = _strip_js_comments(js_text)
    used = set(re.findall(r"['\"`](/api/[^'\"`?\s]*)", code))
    assert used, "analyze.js references no /api/ endpoint"
    assert used <= ALLOWED_API, f"unexpected endpoints: {sorted(used - ALLOWED_API)}"
    assert "/api/pipeline/analyze" in used
    assert {"/api/stage1/analyze", "/api/stage2/analyze"} <= used
    assert "XMLHttpRequest" not in code and "WebSocket" not in code
    assert not re.search(r"fetch\(\s*['\"`]https?://", code), "fetch to an absolute external URL"


def test_live_js_uses_local_live_api_and_safe_text_rendering():
    code = _strip_js_comments(LIVE_JS.read_text(encoding="utf-8"))
    used = set(re.findall(r"['\"`](/api/[^'\"`?\s]*)", code))
    assert used == {"/api/live/start", "/api/live/start-upload", "/api/live/stop", "/api/live/events", "/api/live/status"}
    assert "innerHTML" not in code and "textContent" in code
    assert "ws://" in code and "location.host" in code
    assert "device_components" in code and "devices.yolo" in code and "devices.x3d" in code and "devices.yunet" in code


def test_live_ui_disables_cuda_without_runtime_support():
    flow = (MOCKUP / "live-flow.js").read_text(encoding="utf-8")
    assert "cudaOption.disabled = !cudaAvailable" in flow
    assert "device.value = 'auto'" in flow
    assert "Auto เลือก GPU" in flow and "Auto ใช้ CPU" in flow


def test_summary_does_not_claim_unique_people_or_confirmed_falls(js_text):
    assert "กล่อง person สูงสุด" in js_text
    assert "ไม่ใช่จำนวนคนที่ยืนยันแล้ว" in js_text
    assert "พบสัญญาณ Fall · ตรวจสอบ" in js_text


def test_analyze_js_gates_badge_on_is_model_output(js_text):
    code = _strip_js_comments(js_text)
    assert "is_model_output" in code
    assert re.search(r"is_model_output\s*===?\s*true", code), "badge must require is_model_output === true"


def test_analyze_js_uses_contract_fields(js_text):
    code = _strip_js_comments(js_text)
    for field in ("image_jpeg_b64", "detections", "xyxy", "class_name", "confidence", "ppe",
                  "windows", "probs", "summary", "error"):
        assert field in code, f"analyze.js never reads contract field {field!r}"


# ---------------- round 2 (plan section 9.2): video player, timeline, technical details ----------------
TECH_DETAILS_TEXT = "รายละเอียดทางเทคนิค"


def _js_creates(code: str, tag: str) -> bool:
    return bool(re.search(rf"(createElement|\bel)\(\s*['\"`]{tag}['\"`]", code))


def test_analyze_view_has_video_with_overlay_canvas(tree):
    view = by_id(tree, "v-analyze")
    videos = [n for n in view.iter() if n.tag == "video"]
    assert videos, "analyze view has no <video> element"
    for video in videos:
        container = video.parent
        assert container is not None and any(n.tag == "canvas" for n in container.iter()), \
            "no overlay <canvas> next to the <video>"


def test_seek_track_is_keyboard_accessible(tree, js_text):
    # Plan 9.4 replaced the clickable Stage 2 segments with one seek track; it must stay keyboard-usable:
    # either a labelled <input type=range> (other than the score filter) or JS-built buttons with aria-labels.
    view = by_id(tree, "v-analyze")
    labelled_for = {n.attrs.get("for") for n in view.iter() if n.tag == "label"}
    ranges = [n for n in view.iter() if n.tag == "input" and n.attrs.get("type") == "range"
              and "แสดงเฉพาะคะแนน" not in _container_of(n).all_text()
              and (n.attrs.get("aria-label") or n.attrs.get("id") in labelled_for)]
    code = _strip_js_comments(js_text)
    aria_buttons = _js_creates(code, "button") and "aria-label" in code
    assert ranges or aria_buttons, "no keyboard-accessible seek track (labelled range input or aria-labelled buttons)"
    assert re.search(r"\.currentTime\s*=(?!=)", code), "the track must seek the video (currentTime =)"


def test_technical_details_are_collapsed(tree, js_text):
    view = by_id(tree, "v-analyze")
    in_html = [n for n in view.iter() if n.tag == "details" and TECH_DETAILS_TEXT in n.all_text()]
    if in_html:
        assert all("open" not in n.attrs for n in in_html), "technical details must start collapsed"
    else:
        code = _strip_js_comments(js_text)
        assert _js_creates(code, "details") and TECH_DETAILS_TEXT in js_text, \
            "technical fields must sit in a collapsed <details> 'รายละเอียดทางเทคนิค'"


def test_analyze_js_uses_dense_mode_with_frames_fallback(js_text):
    code = _strip_js_comments(js_text)
    assert re.search(r"['\"`]mode['\"`]", code), "analyze.js never sends the 'mode' field"
    assert re.search(r"['\"`]dense['\"`]", code), "analyze.js never requests mode=dense"
    assert re.search(r"['\"`]frames['\"`]", code), "analyze.js has no frames-mode fallback"
    assert "loadedmetadata" in code, "playability probe must wait for loadedmetadata"
    assert "sample_fps" in code


def test_analyze_js_manages_object_urls(js_text):
    code = _strip_js_comments(js_text)
    assert "URL.createObjectURL" in code and "URL.revokeObjectURL" in code


CONTRACT_FORM_FIELDS = {"file", "model", "device", "max_frames", "mode", "sample_fps", "analysis_settings",
                        "face_confidence", "face_padding", "face_blur_strength"}


def test_analyze_js_sends_only_contract_form_fields(js_text):
    code = _strip_js_comments(js_text)
    sent = set(re.findall(r"\.append\(\s*['\"`]([A-Za-z_]+)['\"`]\s*,", code))
    sent -= {"click", "change", "input"}  # not FormData keys
    assert {"file", "model"} <= sent, f"FormData fields found: {sorted(sent)}"
    assert sent <= CONTRACT_FORM_FIELDS, f"fields outside the contract: {sorted(sent - CONTRACT_FORM_FIELDS)}"


# ---------------- round 2 (plan section 9.3): Stage 1 readability ----------------
def _container_of(node, levels=2):
    for _ in range(levels):
        if node.parent is not None:
            node = node.parent
    return node


def test_class_toggle_controls_exist(tree, js_text):
    view = by_id(tree, "v-analyze")
    groups = [n for n in view.iter()
              if n.attrs.get("role") == "group" or any("chip" in c for c in n.attrs.get("class", "").split())]
    assert groups, "no container for per-class toggle chips in the analyze view"
    code = _strip_js_comments(js_text)
    assert "aria-pressed" in code and "class_name" in code, "per-class toggles must be driven by class_name"


def test_ppe_view_toggle_exists(tree):
    view = by_id(tree, "v-analyze")
    toggles = [n for n in view.iter() if n.tag == "button" and "มุมมอง PPE" in n.all_text()]
    assert toggles, "no 'มุมมอง PPE' toggle button in the analyze view"


def test_confidence_slider_is_display_only(tree, js_text):
    view = by_id(tree, "v-analyze")
    sliders = [n for n in view.iter() if n.tag == "input" and n.attrs.get("type") == "range"
               and "แสดงเฉพาะคะแนน" in _container_of(n).all_text()]
    assert sliders, "no 'แสดงเฉพาะคะแนน ≥' range slider in the analyze view"
    note = _container_of(sliders[0]).all_text()
    assert "API" in note or "threshold" in note, "the slider must say it does not change API thresholds"
    # the contract-field check above already guarantees it is never sent; also no threshold override field
    code = _strip_js_comments(js_text)
    assert not re.search(r"\.append\(\s*['\"`](min_conf|conf|threshold|thresholds)['\"`]", code)


def test_label_font_is_not_scaled_from_source_pixels(js_text):
    code = _strip_js_comments(js_text)
    assert any(k in code for k in ("devicePixelRatio", "clientWidth", "getBoundingClientRect")), \
        "label drawing should account for the on-screen canvas size"
    for line in re.findall(r"\.font\s*=([^;\n]*)", code):
        assert "width" not in line and "height" not in line, f"font size derived from pixel size: {line.strip()}"


# ---------------- round 3 (plan section 9.4): simplified results ----------------
def _ui_ids(js: str) -> dict[str, str]:
    """``name: $('id')`` entries of analyze.js's element map -> {name: id}."""
    return dict(re.findall(r"(\w+)\s*:\s*\$\(\s*['\"]([\w-]+)['\"]\s*\)", js))


def _ids_outside_details(node, inside=False, out=None):
    out = set() if out is None else out
    inside = inside or node.tag == "details"
    if not inside and node.attrs.get("id"):
        out.add(node.attrs["id"])
    for child in node.children:
        _ids_outside_details(child, inside, out)
    return out


def _stage2_card(tree):
    view = by_id(tree, "v-analyze")
    cards = [n for n in view.iter() if "card" in n.attrs.get("class", "").split()
             and "X3D" in n.all_text() and REAL_BADGE_TEXT in n.all_text()]
    assert cards, "no Stage 2 card in the analyze view"
    return min(cards, key=lambda n: len(list(n.iter())))


def test_green_notes_removed(html_text, js_text):
    for text in (html_text, _strip_js_comments(js_text)):
        assert "หน้านี้แสดงผลจากโมเดลจริงผ่าน API" not in text
        assert not re.search(r"เบราว์เซอร์เล่นวิดีโอนี้ได้(?!หรือไม่)", text), "'เบราว์เซอร์เล่นวิดีโอนี้ได้ →' note still shown"


def test_class_chips_show_label_only(tree, js_text):
    view = by_id(tree, "v-analyze")
    groups = [n for n in view.iter() if n.attrs.get("role") == "group" and "class" in n.attrs.get("aria-label", "")
              and not any(c.tag == "button" for c in n.children)]  # the (JS-filled) chip container
    assert groups, "no class-chip container (role=group mentioning class) in the analyze view"
    code = _strip_js_comments(js_text)
    names = [k for k, v in _ui_ids(code).items() if v in {g.attrs.get("id") for g in groups}]
    assert names, "class-chip container is not referenced from analyze.js"
    for name in names:
        start = code.find(f"clear(ui.{name})")
        end = code.rfind(f"ui.{name}.appendChild")
        assert start >= 0 and end > start, f"cannot locate the chip-building code for ui.{name}"
        block = code[start:end]
        assert "เฟรม" not in block, "class chips must not render frame counts"
        assert not re.search(r"frames\.filter\([^;]*\)\.length", block)


def test_stage2_visible_panel_has_no_window_rows(tree, js_text):
    card = _stage2_card(tree)
    assert any(n.tag == "details" for n in card.iter()), "Stage 2 technical details must be a <details>"
    visible_ids = _ids_outside_details(card)
    code = _strip_js_comments(js_text)
    visible_names = [k for k, v in _ui_ids(code).items() if v in visible_ids]
    for name in visible_names:
        for rhs in re.findall(rf"ui\.{name}\.textContent\s*=([^;]*);", code):
            assert not re.search(r"start_s|end_s|probs|%", rhs), f"visible Stage 2 text ui.{name} shows window data"
        for arg in re.findall(rf"ui\.{name}\.appendChild\(([^;]*)\);", code):
            assert not re.search(r"start_s|end_s|probs", arg), f"window rows appended to visible ui.{name}"
    static_visible = "".join("".join(n.text) for n in card.iter()
                             if n.attrs.get("id") in visible_ids or n is card)
    assert "%" not in static_visible


def test_ppe_check_toggle_exists_and_is_display_only(tree, js_text):
    view = by_id(tree, "v-analyze")
    toggles = [n for n in view.iter()
               if (n.tag == "button" or (n.tag == "input" and n.attrs.get("type") == "checkbox"))
               and "ตรวจ PPE" in (n.all_text() + n.attrs.get("aria-label", "")) and "มุมมอง" not in n.all_text()]
    if not toggles:  # checkbox labelled by a <label>
        toggles = [n for n in view.iter() if n.tag == "label" and "ตรวจ PPE" in n.all_text()]
    assert toggles, "no 'ตรวจ PPE' toggle in the analyze view"
    code = _strip_js_comments(js_text)
    assert not re.search(r"\.append\(\s*['\"`](ppe|ppe_check|check_ppe)['\"`]", code)


def test_view_selector_and_person_based_default(tree, js_text):
    view = by_id(tree, "v-analyze")
    selectors = [n for n in view.iter()
                 if "PPE" in n.all_text() and "เลือก class" in n.all_text()
                 and sum(1 for c in n.iter() if c.tag in ("button", "input", "option")) >= 2]
    assert selectors, "no view selector offering 'มุมมอง PPE' and 'เลือก class'"
    code = _strip_js_comments(js_text)
    assert re.search(r"class_name\s*===?\s*['\"]person['\"]", code), "default view must depend on person detections"
    assert re.search(r"\?\s*['\"`]\w*ppe\w*['\"`]\s*:\s*['\"`]\w+['\"`]", code, re.I), \
        "no default-view choice between a PPE view and the class view"


def test_disclaimer_still_rendered(js_text):
    code = _strip_js_comments(js_text)
    assert re.search(r"\.disclaimer\b", code), "analyze.js must render the API disclaimer"
