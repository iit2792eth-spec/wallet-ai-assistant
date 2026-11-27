# v2 classifier results

## Acceptance

| metric                                                       |   value | target   |   pass |
|:-------------------------------------------------------------|--------:|:---------|-------:|
| False alarms on documentation prose (v2 test_docs)           |     2.2 | <= 5.0%  |      1 |
| False alarms on wallet help text (v2 test_wallet_help, real) |     3.5 | <= 10.0% |      1 |
| False alarms on wallet help (synthetic held-out templates)   |     0   | <= 10.0% |      1 |
| Held-out attack families caught (v1 test_heldout)            |    89.4 | >= 75.0% |      1 |
| CrAI test attacks caught (v1 test_ood_crai)                  |    99   | >= 90.0% |      1 |
| Red-team set caught (redteam_manual)                         |   nan   | >= 80.0% |        |
| In-distribution test, no regression (v1 test_id)             |    98.1 | >= 94.8% |      1 |
| New attack templates caught (v2 test_attacks_v2, report)     |    99.2 | report   |        |
| Unseen styles: role play + quoted email (report)             |    99.2 | report   |        |

## All test sets

| test set                  |   new n |   new detect_% |   new false_alarm_% |   new missed |   old@0.96 detect_% |   old@0.96 false_alarm_% |   old@0.98 detect_% |   old@0.98 false_alarm_% |
|:--------------------------|--------:|---------------:|--------------------:|-------------:|--------------------:|-------------------------:|--------------------:|-------------------------:|
| v1 test_id                |     426 |           98.1 |                 0.5 |            4 |                94.8 |                      0   |                92   |                      0   |
| v1 test_heldout           |    1243 |           89.4 |                 1.2 |           72 |                76   |                      3.5 |                69.8 |                      1.8 |
| v1 test_ood_crai          |    2233 |           99   |                 4.5 |           11 |                94.9 |                      3.4 |                87   |                      2.5 |
| v2 test_docs              |     826 |          nan   |                 2.2 |            0 |               nan   |                     15.9 |               nan   |                      8.7 |
| v2 test_wallet_help       |     708 |          nan   |                 3.5 |            0 |               nan   |                     21.8 |               nan   |                     10.7 |
| v2 test_wallet_help_synth |      79 |          nan   |                 0   |            0 |               nan   |                     63.3 |               nan   |                     38   |
| v2 test_synth_clean       |     312 |          nan   |                 1.6 |            0 |               nan   |                     18.3 |               nan   |                      9.9 |
| v2 test_attacks_v2        |     522 |           99.2 |               nan   |            4 |                90.6 |                    nan   |                80.5 |                    nan   |
| v2 test_unseen_styles     |     145 |           99.2 |                 8.3 |            1 |                97.7 |                     16.7 |                86.5 |                      8.3 |
| v2 test_contrast          |     127 |          100   |                31.9 |            0 |                89.1 |                     79.2 |                89.1 |                     72.2 |

Threshold 0.0849 (dev only), temperature 2.300 baked into the head, commit 2c56fc5f04f5bc9ffbe01e298b76bf6d7d0a67b5.
