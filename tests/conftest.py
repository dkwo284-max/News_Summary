import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "tests" / "fixtures"))

import pytest  # noqa: E402

from common import load_config  # noqa: E402


@pytest.fixture
def cfg():
    return load_config(ROOT / "config.yaml")


@pytest.fixture
def fixtures_dir():
    return ROOT / "tests" / "fixtures" / "feeds"
