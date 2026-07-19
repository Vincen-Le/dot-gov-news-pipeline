import importlib.util
import json
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "eval" / "run_judges.py"
spec = importlib.util.spec_from_file_location("run_judges", SCRIPT)
run_judges = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run_judges)


def test_record_judge_model_uses_actual_environment_model(tmp_path, monkeypatch):
    (tmp_path / "metadata.json").write_text(
        json.dumps({"pipeline": "complex_v1", "judge_model": None})
    )
    monkeypatch.setenv("EVAL_JUDGE_MODEL", "claude-test-model")

    assert run_judges.record_judge_model(tmp_path) == "claude-test-model"
    assert json.loads((tmp_path / "metadata.json").read_text())["judge_model"] == (
        "claude-test-model"
    )
