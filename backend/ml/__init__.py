"""
backend.ml — bridge to Thornveil's proprietary ML packages.

The actual model architectures, training methodologies, and inference
glue used in production deploys live in separate Thornveil-managed
private packages and are loaded at deploy time on Thornveil-managed
boxes only. This subpackage is the public bridge that exposes
capability availability without disclosing the underlying mechanism.

When Thornveil-licensed inference is enabled (by setting the
SPIRE_THORNVEIL_ML env var to point at the private package install),
SPIRE imports the model loaders / inference helpers from there and
the BASTION live-feed surface activates. Without that, SPIRE runs
in scripted-sim mode and the model card displays the Thornveil
product name + capability without architecture details.

For licensing inquiries (production deploy, real inference, model
weights): jesse@thornveil.ai. See LICENSE.md §2 and §4.
"""
