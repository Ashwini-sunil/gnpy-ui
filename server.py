"""GNPy Topology Studio backend with standard and research results."""
from __future__ import annotations

import json
import logging
import re
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

ROOT = Path(__file__).resolve().parent
app = Flask(__name__, static_folder="static", static_url_path="")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("gnpy-ui")

ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
HEADER_RE = re.compile(
    r"^(Transceiver|Fiber|RamanFiber|Edfa|Roadm|Fused|Multiband_amplifier)\s+(\S.*\S|\S)$"
)
METRIC_RE = re.compile(
    r"^\s*(?P<name>[A-Za-z][\w /(),.\-+%]*?)\s*:\s*"
    r"(?P<value>[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)"
    r"(?:\s*(?P<unit>.*?))?\s*$"
)
FINAL_GSNR_RE = re.compile(r"Final GSNR \(([^)]+)\):\s*(-?\d+(?:\.\d+)?)")


@app.after_request
def disable_static_cache(response):
    if request.path == "/" or request.path.endswith((".html", ".css", ".js")):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response


def parse_transmission_stdout(raw: str):
    """Parse all numeric element metrics while retaining units separately."""
    text = ANSI_RE.sub("", raw)
    elements = []
    current = None

    for original_line in text.splitlines():
        line = original_line.rstrip()
        header = HEADER_RE.match(line)
        if header:
            current = {
                "type": header.group(1),
                "uid": header.group(2).strip(),
                "metrics": {},
                "metric_units": {},
            }
            elements.append(current)
            continue

        if current is None:
            continue

        metric = METRIC_RE.match(line)
        if not metric:
            continue

        name = metric.group("name").strip()
        current["metrics"][name] = float(metric.group("value"))
        unit = (metric.group("unit") or "").strip()
        if unit:
            current["metric_units"][name] = unit

    final_gsnr = None
    match = FINAL_GSNR_RE.search(text)
    if match:
        final_gsnr = {"unit": match.group(1), "value": float(match.group(2))}
    return elements, final_gsnr


def sanitize_topology(topology):
    clean = json.loads(json.dumps(topology))
    for element in clean.get("elements", []):
        metadata = element.get("metadata")
        if isinstance(metadata, dict):
            metadata.pop("ui_position", None)
    return clean


def execute(command, cwd, request_id, timeout=300):
    log.info("[%s] command=%s", request_id, subprocess.list2cmdline(command))
    result = subprocess.run(
        command,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )
    log.info(
        "[%s] returncode=%s stdout_bytes=%s stderr_bytes=%s",
        request_id,
        result.returncode,
        len(result.stdout),
        len(result.stderr),
    )
    if result.stderr:
        log.warning("[%s] stderr_tail=%s", request_id, result.stderr[-4000:])
    return result


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.post("/api/run")
def run_api():
    request_id = uuid.uuid4().hex[:10]
    try:
        body = request.get_json(force=True)
    except Exception as error:
        return jsonify(error=f"Invalid JSON: {error}", request_id=request_id), 400

    mode = body.get("mode")
    topology = sanitize_topology(body.get("topology") or {})
    equipment = body.get("equipment")
    service = body.get("service")
    spectrum = body.get("spectrum")
    source = body.get("source")
    destination = body.get("destination")
    launch_power = body.get("launch_power")
    no_insert_edfas = bool(body.get("no_insert_edfas", False))
    show_channels = bool(body.get("show_channels", False))
    research_mode = bool(body.get("research_mode", True))

    spectrum_channels = spectrum.get("spectrum", []) if isinstance(spectrum, dict) else []
    log.info(
        "[%s] POST /api/run mode=%s source=%s destination=%s elements=%s links=%s channels=%s research=%s",
        request_id,
        mode,
        source,
        destination,
        len(topology.get("elements", [])),
        len(topology.get("connections", [])),
        len(spectrum_channels),
        research_mode,
    )
    if spectrum_channels:
        log.info("[%s] spectrum_first=%s", request_id, json.dumps(spectrum_channels[:3], indent=2))
        log.info("[%s] spectrum_last=%s", request_id, json.dumps(spectrum_channels[-3:], indent=2))

    if not topology.get("elements"):
        return jsonify(error="Topology has no elements", request_id=request_id), 400
    if not equipment:
        return jsonify(error="Equipment library missing", request_id=request_id), 400

    try:
        with tempfile.TemporaryDirectory() as temp_directory:
            workdir = Path(temp_directory)
            topology_path = workdir / "topology.json"
            equipment_path = workdir / "eqpt.json"
            topology_path.write_text(json.dumps(topology, indent=2), encoding="utf-8")
            equipment_path.write_text(json.dumps(equipment, indent=2), encoding="utf-8")

            spectrum_path = None
            if spectrum_channels:
                spectrum_path = workdir / "spectrum.json"
                spectrum_path.write_text(json.dumps(spectrum, indent=2), encoding="utf-8")
                log.info("[%s] spectrum_file=%s bytes=%s", request_id, spectrum_path, spectrum_path.stat().st_size)

            if mode == "transmission":
                cli_args = [str(topology_path)]
                if source and destination:
                    cli_args.extend([str(source), str(destination)])
                cli_args.extend(["-e", str(equipment_path)])
                if launch_power is not None:
                    cli_args.extend(["-po", str(float(launch_power))])
                if spectrum_path:
                    cli_args.extend(["--spectrum", str(spectrum_path)])
                if no_insert_edfas:
                    cli_args.append("--no-insert-edfas")
                if show_channels:
                    cli_args.append("--show-channels")

                command = ["gnpy-transmission-example", *cli_args]
                standard_result = execute(command, workdir, request_id)
                elements, final_gsnr = (
                    parse_transmission_stdout(standard_result.stdout)
                    if standard_result.returncode == 0
                    else ([], None)
                )

                research = None
                research_error = None
                if research_mode and source and destination:
                    research_path = workdir / "research.json"
                    research_command = [
                        sys.executable,
                        str(ROOT / "research_runner.py"),
                        "--output",
                        str(research_path),
                        "--source",
                        str(source),
                        "--destination",
                        str(destination),
                        *cli_args,
                    ]
                    research_result = execute(research_command, workdir, request_id, timeout=600)

                    if research_path.exists():
                        try:
                            research = json.loads(research_path.read_text(encoding="utf-8"))
                        except Exception as error:
                            research_error = f"Research JSON parse failed: {error}"

                    if research_result.returncode != 0 and not research_error:
                        research_error = (
                            research_result.stderr[-4000:]
                            or f"Research runner returned {research_result.returncode}"
                        )

                    log.info(
                        "[%s] research returncode=%s file_exists=%s elements=%s",
                        request_id,
                        research_result.returncode,
                        research_path.exists(),
                        len(research.get("elements", [])) if research else 0,
                    )
                    if research_error:
                        log.error("[%s] research_error=%s", request_id, research_error)

                return jsonify(
                    request_id=request_id,
                    returncode=standard_result.returncode,
                    stdout=standard_result.stdout,
                    stderr=standard_result.stderr,
                    parsed=[],
                    elements=elements,
                    final_gsnr=final_gsnr,
                    command=command,
                    research=research,
                    research_error=research_error,
                )

            if mode == "path-request":
                if not service:
                    return jsonify(error="Service file missing", request_id=request_id), 400
                service_path = workdir / "service.json"
                output_path = workdir / "results.json"
                service_path.write_text(json.dumps(service, indent=2), encoding="utf-8")
                command = [
                    "gnpy-path-request",
                    str(topology_path),
                    str(service_path),
                    "-e",
                    str(equipment_path),
                    "-o",
                    str(output_path),
                ]
                result = execute(command, workdir, request_id)
                parsed = []
                if output_path.exists():
                    data = json.loads(output_path.read_text(encoding="utf-8"))
                    for response in data.get("response", []):
                        row = {"response-id": response.get("response-id", "")}
                        for metric in response.get("path-properties", {}).get("path-metric", []):
                            row[metric.get("metric-type")] = metric.get("accumulative-value")
                        parsed.append(row)
                return jsonify(
                    request_id=request_id,
                    returncode=result.returncode,
                    stdout=result.stdout,
                    stderr=result.stderr,
                    parsed=parsed,
                    command=command,
                )

            return jsonify(error=f"Unknown mode: {mode}", request_id=request_id), 400

    except subprocess.TimeoutExpired:
        return jsonify(error="Calculation exceeded timeout", request_id=request_id), 504
    except Exception as error:
        log.exception("[%s] /api/run failed", request_id)
        return jsonify(error=str(error), request_id=request_id), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8501, debug=False)
