#!/bin/sh
set -eu
TASK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -n "${JAVA_HOME:-}" ]; then
  TASK_JAVA="$JAVA_HOME/bin/java"
else
  TASK_JAVA=java
fi
exec "$TASK_JAVA" -classpath "$TASK_DIR/gradle/wrapper/gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain "$@"
