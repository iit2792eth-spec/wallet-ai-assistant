"""Scores every labelled segment split of the dataset with one backend.

  python score_splits.py pt   <hf_model_dir>   <dataset_data_dir> scores_pt.json
  python score_splits.py onnx <app_model_dir>  <dataset_data_dir> scores_onnx.json

pt   = the fine-tuned PyTorch model (e.g. v2_data_fix/model)
onnx = the exported model the app runs (models/injection-classifier, file onnx/model.onnx)

Run each backend in its own process: onnxruntime's spinning threads starve PyTorch in a shared one.
"""
import os, sys, json, time
import numpy as np
from transformers import AutoTokenizer

# v1 splits, then the v2 splits (data/v2/, present from the v2-data-fix branch on). Missing or empty files are skipped.
SPLITS = ["val", "dev_ood_crai", "test_id", "test_heldout", "test_ood_crai", "redteam_manual",
          "v2/dev", "v2/test_docs", "v2/test_wallet_help", "v2/test_wallet_help_synth", "v2/test_synth_clean",
          "v2/test_attacks_v2", "v2/test_unseen_styles", "v2/test_contrast"]
MAX_LEN = 256


def main():
    backend, model_dir, data_dir, out = sys.argv[1:5]
    tok = AutoTokenizer.from_pretrained(model_dir)
    if backend == "pt":
        import torch
        from transformers import AutoModelForSequenceClassification
        model = AutoModelForSequenceClassification.from_pretrained(model_dir).eval()
        names = {"input_ids", "attention_mask", "token_type_ids"}

        def logits(feed):
            with torch.no_grad():
                return model(**{k: torch.from_numpy(v) for k, v in feed.items()}).logits.numpy()
    else:
        import onnxruntime as ort
        opts = ort.SessionOptions(); opts.intra_op_num_threads = 4
        sess = ort.InferenceSession(f"{model_dir}/onnx/model.onnx", opts, providers=["CPUExecutionProvider"])
        names = {i.name for i in sess.get_inputs()}

        def logits(feed):
            return sess.run(None, feed)[0]

    result = {}
    for split in SPLITS:
        path = f"{data_dir}/{split}.jsonl"
        if not os.path.exists(path) or not os.path.getsize(path):
            continue
        texts = [json.loads(line)["text"] for line in open(f"{data_dir}/{split}.jsonl") if line.strip()]
        probs, start = [], time.time()
        for i in range(0, len(texts), 32):
            enc = tok(texts[i:i + 32], truncation=True, max_length=MAX_LEN, padding=True, return_tensors="np")
            lg = logits({k: v.astype(np.int64) for k, v in enc.items() if k in names})
            e = np.exp(lg - lg.max(-1, keepdims=True))
            probs += (e / e.sum(-1, keepdims=True))[:, 1].tolist()
        result[split] = probs
        print(backend, split, len(texts), f"{(time.time() - start) / len(texts) * 1000:.1f} ms/segment", flush=True)
    json.dump(result, open(out, "w"))


if __name__ == "__main__":
    main()
