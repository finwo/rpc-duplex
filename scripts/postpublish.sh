#!/bin/sh

# Ensure we're in the script dir
cd "$(dirname "$0")"

# Fetch info
version=$(node -p "require('../package.json').version")
name=$(node -p "require('../package.json').name")

npm deprecate ${name}@"< ${version}" "Rolling release; please update to version ${version}"
