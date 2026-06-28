#!/bin/bash

echo "Starting agent..."

if [ -f "/agent.yaml" ]; then
  yq -r '.run' /agent.yaml | bash
fi

export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"

exec "$@"
