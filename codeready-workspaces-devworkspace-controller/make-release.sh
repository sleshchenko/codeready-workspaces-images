#!/bin/bash
# Copyright (c) 2021 Red Hat, Inc.
# This program and the accompanying materials are made
# available under the terms of the Eclipse Public License 2.0
# which is available at https://www.eclipse.org/legal/epl-2.0/
#
# SPDX-License-Identifier: EPL-2.0
#
# Contributors:
#   Red Hat, Inc. - initial API and implementation
#

set -e
REPO=git@github.com:devfile/devworkspace-operator
MAIN_BRANCH="main"
TMP=""

while [[ "$#" -gt 0 ]]; do
  case $1 in
    '-v'|'--version') VERSION="$2"; shift 1;;
    '-tmp'|'--use-tmp-dir') TMP=$(mktemp -d); shift 0;;
  esac
  shift 1
done

bump_version () {
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

  NEXT_VERSION=$1
  BUMP_BRANCH=$2

  git checkout "${BUMP_BRANCH}"

  echo "Updating project version to ${NEXT_VERSION}"
  # change version/version.go file
  sed -i version/version.go -r -e 's#(Version = ")([0-9.]+)(")#\1'"${NEXT_VERSION}"'\3#g'
  if [[ ! -z $(git status -s) ]]; then # dirty
    git add version/version.go
    COMMIT_MSG="[release] Bump to ${NEXT_VERSION} in ${BUMP_BRANCH}"
    git commit -asm "${COMMIT_MSG}"
  fi
  git pull origin "${BUMP_BRANCH}"

  set +e
  PUSH_TRY="$(git push origin "${BUMP_BRANCH}")"
  # shellcheck disable=SC2181
  if [[ $? -gt 0 ]] || [[ $PUSH_TRY == *"protected branch hook declined"* ]]; then
    PR_BRANCH=pr-${BUMP_BRANCH}-to-${NEXT_VERSION}
    # create pull request for the main branch branch, as branch is restricted
    git branch "${PR_BRANCH}"
    git checkout "${PR_BRANCH}"
    git pull origin "${PR_BRANCH}"
    git push origin "${PR_BRANCH}"
    lastCommitComment="$(git log -1 --pretty=%B)"
    hub pull-request -f -m "${lastCommitComment}" -b "${BUMP_BRANCH}" -h "${PR_BRANCH}"
  fi
  set -e
  git checkout "${CURRENT_BRANCH}"
}

usage ()
{
  echo "Usage: $0 --version [VERSION TO RELEASE]"
  echo "Example: $0 --version v0.1.0"; echo
}

if [[ ! ${VERSION} ]]; then
  usage
  exit 1
fi


# derive bugfix branch from version
BRANCH=${VERSION#v}
BRANCH=${BRANCH%.*}.x

# if doing a .0 release, use main branch; if doing a .z release, use $BRANCH
if [[ ${VERSION} == *".0" ]]; then
  BASEBRANCH="${MAIN_BRANCH}"
else
  BASEBRANCH="${BRANCH}"
fi

# work in tmp dir
if [[ $TMP ]] && [[ -d $TMP ]]; then
  pushd "$TMP" > /dev/null || exit 1
  # get sources from ${BASEBRANCH} branch
  echo "Check out ${REPO} to ${TMP}/${REPO##*/}"
  git clone "${REPO}" -q
  cd "${REPO##*/}" || exit 1
fi

git remote show origin

# get sources from ${BASEBRANCH} branch
git fetch origin "${BASEBRANCH}":"${BASEBRANCH}" || true
git checkout "${BASEBRANCH}"

# create new branch off ${BASEBRANCH} (or check out latest commits if branch already exists), then push to origin
if [[ "${BASEBRANCH}" != "${BRANCH}" ]]; then
  git branch "${BRANCH}" || git checkout "${BRANCH}"
  git push origin "${BRANCH}"
  git fetch origin "${BRANCH}:${BRANCH}" || true
  git checkout "${BRANCH}"
else
  git fetch origin "${BRANCH}:${BRANCH}" || true
  git checkout "${BRANCH}"
fi
set -e

# change version/version.go file
sed -i version/version.go -r -e 's#(Version = ")([0-9.]+)(")#\1'"${VERSION}"'\3#g'

DWO_QUAY_IMG="quay.io/devfile/devworkspace-controller:${VERSION}"
docker build -t "${DWO_QUAY_IMG}" -f ./build/Dockerfile .
docker push "${DWO_QUAY_IMG}"

PROJECT_CLONE_QUAY_IMG="quay.io/devfile/project-clone:${VERSION}"
docker build -t "${PROJECT_CLONE_QUAY_IMG}" -f ./project-clone/Dockerfile .
docker push "${PROJECT_CLONE_QUAY_IMG}"

set -x
bash -x ./deploy/generate-deployment.sh \
  --use-defaults \
  --default-image ${DWO_QUAY_IMG} \
  --project-clone-image ${PROJECT_CLONE_QUAY_IMG}

# tag the release if the version/version.go file has changed
if [[ ! -z $(git status -s) ]]; then # dirty
  COMMIT_MSG="[release] Release ${VERSION}"
  git add version/version.go
  git commit -asm "${COMMIT_MSG}"
  git tag "${VERSION}"
  git push origin "${VERSION}"
fi

# now update ${BASEBRANCH} to the new snapshot version
git checkout "${BASEBRANCH}"

# change VERSION file + commit change into ${BASEBRANCH} branch
if [[ "${BASEBRANCH}" != "${BRANCH}" ]]; then
  # bump the y digit, if it is a major release
  [[ $BRANCH =~ ^([0-9]+)\.([0-9]+)\.x ]] && BASE=${BASH_REMATCH[1]}; NEXT=${BASH_REMATCH[2]}; (( NEXT=NEXT+1 )) # for BRANCH=0.1.x, get BASE=0, NEXT=2
  NEXT_VERSION_Y="${BASE}.${NEXT}.0-SNAPSHOT"
  bump_version "${NEXT_VERSION_Y}" "${BASEBRANCH}"
fi
# bump the z digit
[[ ${VERSION#v} =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]] && BASE="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"; NEXT="${BASH_REMATCH[3]}"; (( NEXT=NEXT+1 )) # for VERSION=0.1.2, get BASE=0.1, NEXT=3
NEXT_VERSION_Z="${BASE}.${NEXT}-SNAPSHOT"
bump_version "${NEXT_VERSION_Z}" "${BRANCH}"

# cleanup tmp dir
if [[ $TMP ]] && [[ -d $TMP ]]; then
  popd > /dev/null || exit
  rm -fr "$TMP"
fi
