"""
backend.ml — vendored model architectures for live inference inside SPIRE.

Each module here ships a self-contained PyTorch model class plus the
inference glue needed to run it from a route handler. Weights live
outside the repo (set via SPIRE_<MODEL>_WEIGHTS env vars); the
architectures live here so the module imports without touching the
external HawkStack/ThermalHawk training repos at runtime.
"""
