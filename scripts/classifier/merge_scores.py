"""Joins per-backend score files with the dataset rows into one CSV.

  python merge_scores.py <dataset_data_dir> scores.csv pt=scores_pt.json onnx=scores_onnx.json
"""
import sys, json, csv


def main():
    data_dir, out = sys.argv[1], sys.argv[2]
    files = dict(arg.split("=", 1) for arg in sys.argv[3:])
    scores = {name: json.load(open(path)) for name, path in files.items()}
    first = next(iter(scores.values()))
    rows = []
    for split in first:
        data = [json.loads(line) for line in open(f"{data_dir}/{split}.jsonl") if line.strip()]
        for i, d in enumerate(data):
            rows.append({
                "split": split, "id": d["id"], "label": d["label"], "source": d.get("source"),
                "crai_tag": d.get("crai_tag"), "hard_case": d.get("hard_case"), "doc_id": d.get("doc_id"),
                "goal": d.get("goal"), "style": d.get("style"), "family": d.get("family"), "text": d["text"],
                **{f"p_{name}": scores[name][split][i] for name in scores},
            })
    with open(out, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader(); writer.writerows(rows)
    print("wrote", len(rows), "rows to", out)


if __name__ == "__main__":
    main()
