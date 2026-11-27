# Classifier results

| model              | split         |    n |   TPR_detect |   FPR_all_clean |   FPR_hard_neg |   missed_injected |
|:-------------------|:--------------|-----:|-------------:|----------------:|---------------:|------------------:|
| ours_finetuned     | test_id       |  426 |        94.84 |            0    |           0    |                11 |
| ours_finetuned     | test_heldout  | 1243 |        75.96 |            3.54 |           2.4  |               163 |
| ours_finetuned     | test_ood_crai | 2233 |        94.88 |            3.36 |         nan    |                58 |
| protectai_offshelf | test_id       |  426 |        73.24 |           21.6  |          21.63 |                57 |
| protectai_offshelf | test_heldout  | 1243 |        59.59 |           12.92 |          13.23 |               274 |
| protectai_offshelf | test_ood_crai | 2233 |        27.18 |           29.82 |         nan    |               825 |
| promptguard2_86m   | test_id       |  426 |        16.43 |            0    |           0    |               178 |
| promptguard2_86m   | test_heldout  | 1243 |        15.04 |            0.18 |           0.2  |               576 |
| promptguard2_86m   | test_ood_crai | 2233 |         3.44 |            0.18 |         nan    |              1094 |
| promptguard2_22m   | test_id       |  426 |        11.27 |            0    |           0    |               189 |
| promptguard2_22m   | test_heldout  | 1243 |         3.69 |            0.18 |           0.2  |               653 |
| promptguard2_22m   | test_ood_crai | 2233 |         1.15 |            0    |         nan    |              1120 |
