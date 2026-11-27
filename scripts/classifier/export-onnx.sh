#!/bin/sh
# Exports the fine-tuned injection classifier to the ONNX layout the app loads:
#   models/injection-classifier/{config.json,tokenizer.json,tokenizer_config.json,...,onnx/model.onnx}
#
#   sh scripts/classifier/export-onnx.sh [hf_model_dir]      (default: v2_data_fix/model)
#
# Needs Python with: pip install -r scripts/classifier/requirements.txt
# Set PYTHON to choose the interpreter (default: python3).
# Full precision only: an 8-bit version changed 412 of 5,012 test decisions (docs/Injection_Classifier.md).
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SRC=${1:-"$ROOT/v2_data_fix/model"}
OUT="$ROOT/models/injection-classifier"
PY=${PYTHON:-python3}
TMP=$(mktemp -d)

"$PY" -m optimum.exporters.onnx --model "$SRC" --task text-classification --opset 18 "$TMP"
mkdir -p "$OUT/onnx"
mv "$TMP/model.onnx" "$OUT/onnx/model.onnx"
for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json; do
  [ -f "$TMP/$f" ] && mv "$TMP/$f" "$OUT/$f"
done
# Keep the training record (threshold chosen in training, settings) next to the export.
[ -f "$SRC/filter_config.json" ] && cp "$SRC/filter_config.json" "$OUT/filter_config.json"
rmdir "$TMP" 2>/dev/null || true
echo "Exported to $OUT"
