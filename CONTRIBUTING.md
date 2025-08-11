# Contributing

## Setup
```
bash
pip install -U pip
pip install -r requirements.txt || true
pip install black ruff isort mypy pytest pytest-cov bandit pre-commit detect-secrets
pre-commit install
```
## Running Checks
```
pre-commit run --all-files
mypy .
pytest --cov --cov-report=term-missing
bandit -q -r .
```
Follow Google-style docstrings. Avoid prints, bare except, mutable default args. Prefer pathlib, absolute imports.
