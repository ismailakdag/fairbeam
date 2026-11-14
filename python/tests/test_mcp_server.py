"""fairbeam mcp (fairbeam/mcp_server.py): the MCP protocol over stdio and the tools against a run
server on temporary folders. No simulation runs unless FAIRBEAM_MCP_RUN_TESTS=1."""

import base64
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fairbeam import mcp_server  # noqa: E402
from fairbeam.mcp_server import TOOLS, Backend, Server, serve_stdio, summarize_bundle  # noqa: E402
from fairbeam.server import App, make_server  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / "examples" / "designs" / "hf_dipole_7mhz.design.json"
BUNDLE = ROOT / "public" / "projects" / "hf-dipole-7mhz.json"


def rpc(server, method, params=None, mid=1):
    return server.handle({"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}})


def call(server, name, args=None):
    res = rpc(server, "tools/call", {"name": name, "arguments": args or {}})["result"]
    return res, res.get("structuredContent")


class Protocol(unittest.TestCase):
    def setUp(self):
        self.server = Server(Backend("http://127.0.0.1:9", embedded=False))

    def test_initialize_negotiates_a_version(self):
        res = rpc(self.server, "initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "t"}})["result"]
        self.assertEqual(res["protocolVersion"], "2025-03-26")
        self.assertEqual(res["serverInfo"]["name"], "fairbeam")
        self.assertIn("tools", res["capabilities"])
        self.assertIn("mm", res["instructions"])
        res = rpc(self.server, "initialize", {"protocolVersion": "1999-01-01"})["result"]
        self.assertEqual(res["protocolVersion"], mcp_server.PROTOCOL_VERSIONS[0])

    def test_tools_have_valid_schemas(self):
        tools = rpc(self.server, "tools/list")["result"]["tools"]
        self.assertEqual({t["name"] for t in tools}, {t["name"] for t in TOOLS})
        for t in tools:
            with self.subTest(t["name"]):
                self.assertRegex(t["name"], r"^[a-z_]{3,40}$")
                self.assertTrue(t["description"])
                self.assertEqual(t["inputSchema"]["type"], "object")
                for key in t["inputSchema"].get("required", []):
                    self.assertIn(key, t["inputSchema"]["properties"])
                self.assertTrue(hasattr(mcp_server.Tools, t["name"]), "every tool has an implementation")

    def test_errors(self):
        self.assertEqual(rpc(self.server, "nope")["error"]["code"], -32601)
        self.assertIsNone(self.server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        self.assertEqual(rpc(self.server, "tools/call", {"name": "nope"})["error"]["code"], -32602)
        res, _ = call(self.server, "get_design")
        self.assertTrue(res["isError"])
        self.assertIn("missing", res["content"][0]["text"])
        res, _ = call(self.server, "status")  # nothing listens on port 9
        self.assertTrue(res["isError"])
        self.assertIn("does not answer", res["content"][0]["text"])

    def test_guide_resource_and_prompts(self):
        _, data = call(self.server, "design_format_guide")
        self.assertIn("fairbeam.design/1", data["guide"])
        read = rpc(self.server, "resources/read", {"uri": "fairbeam://guide/design-format"})["result"]
        self.assertIn("lumped", read["contents"][0]["text"])
        names = {p["name"] for p in rpc(self.server, "prompts/list")["result"]["prompts"]}
        self.assertEqual(names, {"design_antenna", "review_result"})
        msg = rpc(self.server, "prompts/get", {"name": "design_antenna", "arguments": {"antenna": "dipole", "frequency": "7.1 MHz"}})
        self.assertIn("7.1 MHz", msg["result"]["messages"][0]["content"]["text"])

    def test_stdio_framing(self):
        lines = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
                 {"jsonrpc": "2.0", "method": "notifications/initialized"},
                 {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}]
        stdin = io.BytesIO(("\n".join(json.dumps(x) for x in lines) + "\nnot json\n").encode())
        stdout = io.BytesIO()
        serve_stdio(self.server, stdin, stdout)
        out = [json.loads(x) for x in stdout.getvalue().decode().splitlines()]
        self.assertEqual([o.get("id") for o in out], [1, 2, None])
        self.assertEqual(out[2]["error"]["code"], -32700)

    def test_client_config(self):
        cfg = mcp_server.client_config("/opt/py/bin/python")
        entry = cfg["mcpServers"]["fairbeam"]
        self.assertEqual(entry["args"], ["-m", "fairbeam", "mcp"])
        self.assertTrue((Path(entry["env"]["PYTHONPATH"]) / "fairbeam" / "mcp_server.py").is_file())
        self.assertIn("claude mcp add fairbeam", cfg["claude_code"])


class Summaries(unittest.TestCase):
    def test_bundle_summary(self):
        b = json.loads(BUNDLE.read_text(encoding="utf-8"))
        s = summarize_bundle(b, include_curves=True, max_points=51)
        self.assertEqual(s["band_text"], "5 MHz – 9 MHz")
        port = s["ports"][0]
        self.assertTrue(6.5e-3 < port["f_min_s11_ghz"] < 7.5e-3)
        self.assertLess(port["min_s11_db"], -10)
        self.assertLessEqual(len(port["curve"]["f_ghz"]), 52)
        self.assertTrue(s["matched_bands"][0]["text"].endswith("MHz"))
        self.assertTrue(s["run"]["converged"])
        self.assertIn("not a measurement", s["note"])


class Tools(unittest.TestCase):
    """The tools against a real run server on temporary folders."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="fairbeam-mcp-"))
        for d in ("models", "projects", "jobs", "sim"):
            (cls.tmp / d).mkdir()
        shutil.copy(EXAMPLE, cls.tmp / "models" / "hf_dipole_7mhz.design.json")
        shutil.copy(BUNDLE, cls.tmp / "projects" / BUNDLE.name)
        cls.app = App(models_dir=cls.tmp / "models", projects_dir=cls.tmp / "projects", jobs_dir=cls.tmp / "jobs",
                      port=0, python=None, ui_dir=None, sim_root=cls.tmp / "sim")
        cls.httpd = make_server(cls.app, "127.0.0.1", 0, quiet=True)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.server = Server(Backend(f"http://127.0.0.1:{cls.httpd.server_address[1]}", embedded=False))

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def ok(self, name, args=None):
        res, data = call(self.server, name, args)
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return data

    def test_status_and_lists(self):
        st = self.ok("status")
        self.assertEqual(st["server_source"], "explicit")
        self.assertEqual(st["fairbeam"], st["mcp_server"])
        self.assertIn("openems", st)
        self.assertEqual(Path(st["projects_dir"]).resolve(), (self.tmp / "projects").resolve())
        ids = [d["id"] for d in self.ok("list_designs")["designs"]]
        self.assertIn("hf_dipole_7mhz", ids)
        self.assertEqual(self.ok("list_designs", {"query": "zzz"})["count"], 0)
        res = self.ok("list_results")["results"]
        self.assertEqual(res[0]["result"], "hf-dipole-7mhz.json")

    def test_config_route(self):
        cfg = self.server.backend.request("GET", "/api/mcp/config")
        self.assertEqual(cfg["mcpServers"]["fairbeam"]["args"], ["-m", "fairbeam", "mcp"])
        self.assertTrue(cfg["claude_code"].startswith("claude mcp add fairbeam"))

    def test_design_round_trip(self):
        made = self.ok("create_design", {"name": "MCP dipole", "template": "dipole"})
        did = made["id"]
        self.assertTrue(did.startswith("mcp_dipole"))
        got = self.ok("get_design", {"id": did})
        self.assertEqual(got["design"]["schema"], "fairbeam.design/1")
        key = got["design"]["params"][0]["key"]
        changed = self.ok("set_parameters", {"id": did, "values": {key: 2.4}})
        self.assertEqual(changed["changed"], {key: 2.4})
        self.assertIn("ok_to_run", changed["checks"])
        self.assertEqual(self.ok("get_design", {"id": did})["design"]["params"][0]["default"], 2.4)
        res, _ = call(self.server, "set_parameters", {"id": did, "values": {"nope": 1}})
        self.assertTrue(res["isError"])
        design = self.ok("get_design", {"id": did})
        design["design"]["model"]["description"] = "edited over MCP"
        saved = self.ok("update_design", {"id": did, "design": design["design"], "base_hash": design["hash"]})
        self.assertNotEqual(saved["hash"], design["hash"])
        res, _ = call(self.server, "update_design", {"id": did, "design": design["design"], "base_hash": design["hash"]})
        self.assertTrue(res["isError"], "a stale hash does not overwrite newer edits")

    def test_render_design(self):
        with tempfile.TemporaryDirectory() as state, mock.patch.dict(os.environ, {"FAIRBEAM_STATE_DIR": state}):
            res, data = call(self.server, "render_design", {"id": "hf_dipole_7mhz", "views": ["front", "top"], "size_px": 500})
            self.assertFalse(res["isError"], res["content"][0]["text"])
            images = [c for c in res["content"] if c["type"] == "image"]
            self.assertEqual(len(images), 1)
            self.assertEqual(images[0]["mimeType"], "image/png")
            png = base64.b64decode(images[0]["data"])
            self.assertTrue(png.startswith(b"\x89PNG"))
            self.assertEqual(Path(data["file"]).read_bytes(), png)
            self.assertNotIn("_images", data)
            self.assertEqual(data["views"], ["front", "top"])
            self.assertAlmostEqual(data["extent_mm"]["size"][2], 19605.6, delta=1)
            self.assertEqual(data["ports"][0]["number"], 1)
            self.assertTrue(data["ok_to_run"])

    def test_estimate_run(self):
        est = self.ok("estimate_run", {"id": "hf_dipole_7mhz"})
        self.assertEqual(est["mesh_lines"], [57, 55, 66])  # 196,560 cells, as on Windows and macOS
        self.assertEqual(est["cells"], 56 * 54 * 65)
        lo, hi = est["timesteps"]
        # the measured run (Mac and Windows) took 9,658 timesteps, about 9 periods of 7 MHz; the range
        # starts at 15 periods like the designer's estimate (meshStats.ts), so it is cautious here
        self.assertLess(lo, 2 * 9658)
        self.assertGreater(hi, 9658)
        self.assertLess(est["seconds"][0], est["seconds"][1])
        self.assertIn(est["memory"]["level"], ("ok", "warn", "unknown"))
        self.assertTrue(est["ok_to_run"])
        res, _ = call(self.server, "estimate_run", {"id": "hf_dipole_7mhz", "engine": "nope"})
        self.assertTrue(res["isError"])

    def test_check_design(self):
        chk = self.ok("check_design", {"id": "hf_dipole_7mhz"})
        self.assertTrue(chk["ok_to_run"], chk)
        self.assertGreater(chk["mesh"]["cells"], 10000)
        broken = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        broken["ports"] = []
        chk = self.ok("check_design", {"design": broken})
        self.assertFalse(chk["ok_to_run"])
        self.assertIn("no-port", [e["code"] for e in chk["errors"]])

    def test_copy_example_and_results(self):
        made = self.ok("create_design", {"name": "My HF dipole", "from_design": "hf_dipole_7mhz"})
        self.assertEqual(self.ok("get_design", {"id": made["id"]})["design"]["params"][0]["key"], "f0")
        res = self.ok("get_results", {"result": "hf-dipole-7mhz"})
        self.assertEqual(res["result"], "hf-dipole-7mhz.json")
        out = self.ok("export_touchstone", {"result": "hf-dipole-7mhz.json"})
        self.assertTrue(Path(out["path"]).is_file())
        self.assertTrue(out["path"].endswith(".s1p"))

    @unittest.skipUnless(os.environ.get("FAIRBEAM_MCP_RUN_TESTS") == "1", "set FAIRBEAM_MCP_RUN_TESTS=1 to run a real simulation")
    def test_run_simulation(self):
        res = self.ok("run_simulation", {"id": "hf_dipole_7mhz", "threads": 2, "points": 101, "timeout_s": 300})
        self.assertEqual(res["status"], "done", res)
        self.assertLess(res["results"]["ports"][0]["min_s11_db"], -10)


class Cli(unittest.TestCase):
    def test_print_config(self):
        env = {**os.environ, "PYTHONPATH": str(ROOT / "python")}
        out = subprocess.run([sys.executable, "-m", "fairbeam", "mcp", "--print-config"], capture_output=True, text=True,
                             env=env, timeout=60, check=True).stdout
        self.assertIn('"fairbeam"', out)

    def test_stdio_subprocess(self):
        env = {**os.environ, "PYTHONPATH": str(ROOT / "python")}
        msgs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}]
        p = subprocess.run([sys.executable, "-m", "fairbeam", "mcp", "--server", "http://127.0.0.1:9"],
                           input="\n".join(json.dumps(m) for m in msgs) + "\n", capture_output=True, text=True,
                           env=env, timeout=60)
        out = [json.loads(x) for x in p.stdout.splitlines()]
        self.assertEqual(out[0]["result"]["serverInfo"]["name"], "fairbeam")
        self.assertGreaterEqual(len(out[1]["result"]["tools"]), 15)
        self.assertIn("ready on stdio", p.stderr, "logs go to stderr, never stdout")


if __name__ == "__main__":
    unittest.main()
