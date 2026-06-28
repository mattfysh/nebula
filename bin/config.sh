params=(-v "$PWD:/code")

if [ -f agent.yaml ]; then
  echo "Configuring mounts..."
  yaml_mounts=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && yaml_mounts+=(-v "$line")
  done < <(yq '
    (.include_ro[] | env(PWD) + "/" + . + ":/code/" + . + ":ro"),
    (.include[]    | env(PWD) + "/" + . + ":/code/" + . )
  ' agent.yaml 2>/dev/null)

  if [ ${#yaml_mounts[@]} -gt 0 ]; then
    params=("${yaml_mounts[@]}")
  fi

  params+=(-v "$PWD/agent.yaml:/agent.yaml:ro")
fi

params+=(
  -p 0:3000
  -e PORT=3000
  -v "bun-cache:/root/.bun/install/cache"
  -v "$root/container/entrypoint.sh:/entrypoint.sh:ro"
)
