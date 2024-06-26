# Impact Evaluator

After deploying a new version of the [`spark-impact-evaluator`](https://github.com/filecoin-station/spark-impact-evaluator),
update the services mentioned in this document.

## contract

- Add address to https://www.notion.so/pl-strflt/Addresses-c1140fd90af94388a9bfbd4f4da2a377#5dda4b1708054349af91fa356e58b950
- Replace Node.js API contract address and publish to NPM
- Send FIL rewards to the contract

## Telemetry

- Replace `0x` and `f4` contract addresses https://github.com/filecoin-station/telegraf/blob/main/telegraf.conf
- Test your changes with `telegraf --config telegraf.conf --test`
- Push to `main` to deploy

## `site-backend`

- Replace `0x` contract address https://github.com/filecoin-station/site-backend/blob/main/lib/getFilEarned.ts
- Test your changes
- Push to `main` to deploy

## Remaining projects

- Merge and release Dependabot PRs (once available)
