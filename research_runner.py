#!/usr/bin/env python3
"""Element-by-element research instrumentation for GNPy 2.14.2.

This wrapper executes gnpy-transmission-example in-process and intercepts each
network element's __call__ method. It records the native SpectralInformation
arrays before and after each element, then derives comparison metrics in linear
units.

Important interpretation notes:
- Native values come directly from GNPy SpectralInformation.
- ASE/NLI generated residuals are derived using observed signal transfer.
- The SRS result in this file is a spectral-transfer proxy, not an isolated
  SRS-only result. A paired SRS-on/SRS-off implementation is required to isolate
  SRS rigorously.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import sys
import traceback
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any

import numpy as np

RECORDS: list[dict[str, Any]] = []


def json_safe(value: Any) -> Any:
    """Convert NumPy objects and non-finite values to valid JSON values."""
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, np.ndarray):
        return json_safe(value.tolist())
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        value = float(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return value


def numeric_array(owner: Any, name: str) -> np.ndarray:
    """Read an attribute as a copied one-dimensional float array."""
    value = getattr(owner, name, None)
    if value is None:
        return np.array([], dtype=float)
    try:
        array = np.asarray(value, dtype=float).copy()
        return np.atleast_1d(array)
    except (TypeError, ValueError):
        return np.array([], dtype=float)


def optional_labels(spectral_info: Any) -> list[str]:
    value = getattr(spectral_info, "label", None)
    if value is None:
        return []
    try:
        return [str(item) for item in value]
    except TypeError:
        return []


def watts_to_dbm(values: Any) -> list[Any]:
    array = np.asarray(values, dtype=float)
    result = np.full(array.shape, np.nan, dtype=float)
    positive = array > 0
    result[positive] = 10 * np.log10(array[positive] / 1e-3)
    return json_safe(result)


def ratio_db(numerator: Any, denominator: Any) -> list[Any]:
    numerator_array = np.asarray(numerator, dtype=float)
    denominator_array = np.asarray(denominator, dtype=float)
    result = np.full(numerator_array.shape, np.nan, dtype=float)
    valid = (numerator_array > 0) & (denominator_array > 0)
    result[valid] = 10 * np.log10(
        numerator_array[valid] / denominator_array[valid]
    )
    return json_safe(result)


def aligned_array(array: np.ndarray, size: int, fill: float = 0.0) -> np.ndarray:
    """Align an optional/scalar array to channel count without inventing data."""
    if size == 0:
        return np.array([], dtype=float)
    if array.size == size:
        return array
    if array.size == 1:
        return np.full(size, float(array[0]), dtype=float)
    if array.size == 0:
        return np.full(size, fill, dtype=float)
    return np.resize(array, size)


def snapshot(spectral_info: Any) -> dict[str, Any]:
    frequency = numeric_array(spectral_info, "frequency")
    size = frequency.size
    signal = aligned_array(numeric_array(spectral_info, "signal"), size)
    ase = aligned_array(numeric_array(spectral_info, "ase"), size)
    nli = aligned_array(numeric_array(spectral_info, "nli"), size)
    total = signal + ase + nli

    native_gsnr = numeric_array(spectral_info, "gsnr_db")
    if native_gsnr.size not in (0, size):
        native_gsnr = aligned_array(native_gsnr, size, np.nan)

    return json_safe(
        {
            "channel_count": int(size),
            "frequency_hz": frequency,
            "frequency_thz": frequency / 1e12,
            "label": optional_labels(spectral_info),
            "baud_rate_hz": aligned_array(
                numeric_array(spectral_info, "baud_rate"), size, np.nan
            ),
            "slot_width_hz": aligned_array(
                numeric_array(spectral_info, "slot_width"), size, np.nan
            ),
            "roll_off": aligned_array(
                numeric_array(spectral_info, "roll_off"), size, np.nan
            ),
            "signal_w": signal,
            "signal_dbm": watts_to_dbm(signal),
            "ase_w": ase,
            "ase_dbm": watts_to_dbm(ase),
            "nli_w": nli,
            "nli_dbm": watts_to_dbm(nli),
            "total_w": total,
            "total_dbm": watts_to_dbm(total),
            "osnr_signal_bw_db": ratio_db(signal, ase),
            "snr_nli_db": ratio_db(signal, nli),
            "gsnr_calculated_db": ratio_db(signal, ase + nli),
            "gsnr_gnpy_db": native_gsnr,
            "chromatic_dispersion_s_per_m": aligned_array(
                numeric_array(spectral_info, "chromatic_dispersion"), size, np.nan
            ),
            "pmd_s": aligned_array(
                numeric_array(spectral_info, "pmd"), size, np.nan
            ),
            "pdl_db": aligned_array(
                numeric_array(spectral_info, "pdl"), size, np.nan
            ),
            "latency_s": aligned_array(
                numeric_array(spectral_info, "latency"), size, np.nan
            ),
            "delta_pdb_per_channel": aligned_array(
                numeric_array(spectral_info, "delta_pdb_per_channel"),
                size,
                np.nan,
            ),
        }
    )


def evaluate_element_parameter(
    element: Any,
    name: str,
    frequencies: np.ndarray,
) -> list[Any]:
    """Safely evaluate a public element parameter over the channel frequencies."""
    attribute = getattr(element, name, None)
    if attribute is None:
        return []
    try:
        value = attribute(frequencies) if callable(attribute) else attribute
        array = np.asarray(value, dtype=float)
        if array.ndim == 0:
            array = np.full(frequencies.size, float(array), dtype=float)
        return json_safe(array)
    except Exception:
        return []


def element_parameters(element: Any, frequencies: np.ndarray) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name in (
        "alpha",
        "beta2",
        "beta3",
        "gamma",
        "cr",
        "chromatic_dispersion",
        "pmd",
        "loss",
    ):
        result[name] = evaluate_element_parameter(element, name, frequencies)

    for name in (
        "effective_gain",
        "nf",
        "gain_profile",
        "interpol_dgt",
        "interpol_gain_ripple",
        "out_voa",
        "pin_db",
        "pout_db",
    ):
        value = getattr(element, name, None)
        if value is not None:
            try:
                result[name] = json_safe(np.asarray(value))
            except Exception:
                result[name] = json_safe(value)

    params = getattr(element, "params", None)
    if params is not None:
        for name in (
            "length",
            "length_units",
            "loss_coef",
            "dispersion",
            "dispersion_slope",
            "effective_area",
            "pmd_coef",
        ):
            value = getattr(params, name, None)
            if value is not None:
                result[f"params.{name}"] = json_safe(value)

    operational = getattr(element, "operational", None)
    if operational is not None:
        for name in (
            "gain_target",
            "tilt_target",
            "out_voa",
            "delta_p",
        ):
            value = getattr(operational, name, None)
            if value is not None:
                result[f"operational.{name}"] = json_safe(value)

    return result


def derive_metrics(
    before: dict[str, Any],
    after: dict[str, Any],
    element: Any,
) -> dict[str, Any]:
    signal_in = np.asarray(before["signal_w"], dtype=float)
    signal_out = np.asarray(after["signal_w"], dtype=float)
    ase_in = np.asarray(before["ase_w"], dtype=float)
    ase_out = np.asarray(after["ase_w"], dtype=float)
    nli_in = np.asarray(before["nli_w"], dtype=float)
    nli_out = np.asarray(after["nli_w"], dtype=float)

    transfer = np.divide(
        signal_out,
        signal_in,
        out=np.zeros_like(signal_out),
        where=signal_in > 0,
    )

    ase_carried = ase_in * transfer
    nli_carried = nli_in * transfer
    ase_residual = np.maximum(ase_out - ase_carried, 0.0)
    nli_residual = np.maximum(nli_out - nli_carried, 0.0)

    transfer_db = np.full(transfer.shape, np.nan, dtype=float)
    valid_transfer = transfer > 0
    transfer_db[valid_transfer] = 10 * np.log10(transfer[valid_transfer])
    finite_transfer = transfer_db[np.isfinite(transfer_db)]
    median_transfer_db = (
        float(np.median(finite_transfer)) if finite_transfer.size else 0.0
    )
    spectral_transfer_proxy_db = transfer_db - median_transfer_db

    frequencies = np.asarray(after["frequency_hz"], dtype=float)

    return json_safe(
        {
            "signal_transfer_linear": transfer,
            "signal_transfer_db": transfer_db,
            "ase_carried_w": ase_carried,
            "ase_carried_dbm": watts_to_dbm(ase_carried),
            "ase_generated_residual_w": ase_residual,
            "ase_generated_residual_dbm": watts_to_dbm(ase_residual),
            "nli_carried_w": nli_carried,
            "nli_carried_dbm": watts_to_dbm(nli_carried),
            "nli_generated_residual_w": nli_residual,
            "nli_generated_residual_dbm": watts_to_dbm(nli_residual),
            "spectral_transfer_proxy_db": spectral_transfer_proxy_db,
            "spectral_transfer_proxy_peak_to_peak_db": (
                float(np.nanmax(spectral_transfer_proxy_db)
                      - np.nanmin(spectral_transfer_proxy_db))
                if finite_transfer.size
                else 0.0
            ),
            "element_parameters": element_parameters(element, frequencies),
            "provenance": {
                "native": [
                    "signal",
                    "ase",
                    "nli",
                    "gsnr_db",
                    "chromatic_dispersion",
                    "pmd",
                    "pdl",
                    "latency",
                ],
                "derived": [
                    "ase_carried",
                    "ase_generated_residual",
                    "nli_carried",
                    "nli_generated_residual",
                    "osnr_signal_bw",
                    "snr_nli",
                    "gsnr_calculated",
                ],
                "spectral_transfer_proxy": (
                    "Observed per-channel signal transfer after removing the "
                    "median transfer. This can contain SRS, wavelength-dependent "
                    "loss, gain ripple, and equalization. It is not an isolated "
                    "SRS-only result."
                ),
            },
        }
    )


def finite_values(values: Any) -> np.ndarray:
    clean = []
    for value in values or []:
        if value is None:
            continue
        number = float(value)
        if math.isfinite(number):
            clean.append(number)
    return np.asarray(clean, dtype=float)


def summarize(record: dict[str, Any]) -> dict[str, Any]:
    after = record["output"]
    derived = record["derived"]

    def mean(values: Any) -> float | None:
        array = finite_values(values)
        return float(np.mean(array)) if array.size else None

    def minimum(values: Any) -> float | None:
        array = finite_values(values)
        return float(np.min(array)) if array.size else None

    return json_safe(
        {
            "channels": after["channel_count"],
            "mean_signal_out_dbm": mean(after["signal_dbm"]),
            "mean_ase_out_dbm": mean(after["ase_dbm"]),
            "mean_nli_out_dbm": mean(after["nli_dbm"]),
            "mean_osnr_out_db": mean(after["osnr_signal_bw_db"]),
            "worst_osnr_out_db": minimum(after["osnr_signal_bw_db"]),
            "mean_gsnr_out_db": mean(after["gsnr_calculated_db"]),
            "worst_gsnr_out_db": minimum(after["gsnr_calculated_db"]),
            "total_ase_in_w": float(np.sum(np.asarray(record["input"]["ase_w"]))),
            "total_ase_out_w": float(np.sum(np.asarray(after["ase_w"]))),
            "total_ase_generated_residual_w": float(
                np.sum(np.asarray(derived["ase_generated_residual_w"]))
            ),
            "total_nli_in_w": float(np.sum(np.asarray(record["input"]["nli_w"]))),
            "total_nli_out_w": float(np.sum(np.asarray(after["nli_w"]))),
            "total_nli_generated_residual_w": float(
                np.sum(np.asarray(derived["nli_generated_residual_w"]))
            ),
            "spectral_transfer_proxy_peak_to_peak_db": derived[
                "spectral_transfer_proxy_peak_to_peak_db"
            ],
        }
    )


def instrument_elements() -> None:
    from gnpy.core.elements import (
        Edfa,
        Fiber,
        Fused,
        Multiband_amplifier,
        RamanFiber,
        Roadm,
        Transceiver,
    )

    for element_class in (
        Fiber,
        RamanFiber,
        Edfa,
        Roadm,
        Fused,
        Transceiver,
        Multiband_amplifier,
    ):
        original_call = element_class.__call__

        def make_wrapper(original_method):
            def wrapper(self, spectral_info, *args, **kwargs):
                before = snapshot(spectral_info)
                result = original_method(self, spectral_info, *args, **kwargs)
                after = snapshot(result)
                record = {
                    "sequence": len(RECORDS),
                    "uid": str(getattr(self, "uid", "")),
                    "type": type(self).__name__,
                    "type_variety": json_safe(getattr(self, "type_variety", None)),
                    "input": before,
                    "output": after,
                }
                record["derived"] = derive_metrics(before, after, self)
                record["summary"] = summarize(record)
                RECORDS.append(record)
                return result

            return wrapper

        element_class.__call__ = make_wrapper(original_call)


def select_final_path(
    records: list[dict[str, Any]],
    source: str,
    destination: str,
) -> list[dict[str, Any]]:
    source_indexes = [
        index for index, record in enumerate(records) if record["uid"] == source
    ]
    for start in reversed(source_indexes):
        for end in range(start, len(records)):
            if records[end]["uid"] == destination:
                return records[start : end + 1]
    return records


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("cli_args", nargs=argparse.REMAINDER)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    cli_args = list(args.cli_args)
    if cli_args and cli_args[0] == "--":
        cli_args = cli_args[1:]

    instrument_elements()
    stdout_buffer = io.StringIO()
    stderr_buffer = io.StringIO()
    returncode = 0

    try:
        from gnpy.tools.cli_examples import transmission_main_example

        sys.argv = ["gnpy-transmission-example", *cli_args]
        with redirect_stdout(stdout_buffer), redirect_stderr(stderr_buffer):
            result = transmission_main_example()
        returncode = int(result or 0)
    except SystemExit as error:
        returncode = int(error.code or 0)
    except Exception:
        returncode = 1
        traceback.print_exc(file=stderr_buffer)

    path_records = select_final_path(RECORDS, args.source, args.destination)
    payload = json_safe(
        {
            "schema_version": 2,
            "gnpy_version": "2.14.2",
            "source": args.source,
            "destination": args.destination,
            "returncode": returncode,
            "stdout": stdout_buffer.getvalue(),
            "stderr": stderr_buffer.getvalue(),
            "instrumented_call_count": len(RECORDS),
            "elements": path_records,
            "notes": [
                "Native values are read directly from GNPy SpectralInformation.",
                "ASE and NLI generated residuals are derived in linear watts using observed signal transfer.",
                "The spectral-transfer proxy is not an isolated SRS-only result.",
                "Zero-noise ratios are represented as null instead of infinity.",
            ],
        }
    )

    Path(args.output).write_text(
        json.dumps(payload, indent=2, allow_nan=False),
        encoding="utf-8",
    )
    return returncode


if __name__ == "__main__":
    raise SystemExit(main())
