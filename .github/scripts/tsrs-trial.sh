#!/usr/bin/env bash
# Shadow of compile's `tsc --noEmit`. CI keeps failures non-blocking.
# Exit 0 only when every project passes; retain compiler exits in the summary.

set -uo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
export PATH="${root}/node_modules/.bin:${PATH}"

if ! command -v tsrs >/dev/null 2>&1; then
  echo "tsrs is not on PATH (expected ${root}/node_modules/.bin/tsrs)"
  exit 127
fi

echo "tsrs $(tsrs --version)"
echo "binary=$(command -v tsrs)"

projects=(.)
overall=0
total_ms=0
summary_rows=()

for project in "${projects[@]}"; do
  echo ""
  echo "======== ${project} ========"
  echo "+ tsrs --noEmit"
  start=$(date +%s%N)
  (cd "${root}/${project}" && tsrs --noEmit)
  code=$?
  end=$(date +%s%N)
  ms=$(((end - start) / 1000000))
  total_ms=$((total_ms + ms))
  secs=$(awk -v ms="${ms}" 'BEGIN { printf "%.3f", ms / 1000 }')
  echo "project=${project} seconds=${secs} exit=${code}"
  if [[ "${code}" -ne 0 ]]; then
    overall=1
  fi
  summary_rows+=("${project}|${secs}|${code}")
done

total_s=$(awk -v ms="${total_ms}" 'BEGIN { printf "%.3f", ms / 1000 }')

echo ""
echo "tsrs trial summary"
printf '%-24s %10s %8s\n' "project" "seconds" "exit"
for row in "${summary_rows[@]}"; do
  project=${row%%|*}
  rest=${row#*|}
  secs=${rest%%|*}
  code=${rest##*|}
  printf '%-24s %10s %8s\n' "${project}" "${secs}" "${code}"
done
printf '%-24s %10s %8s\n' "TOTAL" "${total_s}" "${overall}"
echo "tsrs_trial_seconds=${total_s} tsrs_trial_exit=${overall}"

if [[ "${overall}" -eq 0 ]]; then
  echo "::notice title=tsrs trial::exit 0 in ${total_s}s across ${#projects[@]} projects"
else
  echo "::warning title=tsrs trial::exit ${overall} in ${total_s}s (non-blocking; compare with pnpm compile)"
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### tsrs trial (non-blocking)"
    echo ""
    echo "Shadow of \`tsc --noEmit\`. A non-zero exit does not fail the CI step."
    echo ""
    echo "| project | seconds | exit |"
    echo "| --- | ---: | ---: |"
    for row in "${summary_rows[@]}"; do
      project=${row%%|*}
      rest=${row#*|}
      secs=${rest%%|*}
      code=${rest##*|}
      echo "| \`${project}\` | ${secs} | ${code} |"
    done
    echo "| **total** | ${total_s} | ${overall} |"
  } >>"${GITHUB_STEP_SUMMARY}"
fi

exit "${overall}"
