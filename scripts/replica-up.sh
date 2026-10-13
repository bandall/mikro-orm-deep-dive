#!/usr/bin/env bash
# primary(3317) → replica(3318) GTID 복제를 띄운다. replica 는 Aurora reader 처럼 super_read_only.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose --profile replica up -d mysql-primary mysql-replica
for svc in mysql-primary mysql-replica; do
  until docker compose exec -T "$svc" mysql -uroot -ptest -e "select 1" >/dev/null 2>&1; do sleep 2; done
done
docker compose exec -T mysql-primary mysql -uroot -ptest -e \
  "CREATE USER IF NOT EXISTS 'repl'@'%' IDENTIFIED WITH mysql_native_password BY 'repl'; GRANT REPLICATION SLAVE ON *.* TO 'repl'@'%';" 2>/dev/null
docker compose exec -T mysql-replica mysql -uroot -ptest -e \
  "STOP REPLICA; CHANGE REPLICATION SOURCE TO SOURCE_HOST='mysql-primary', SOURCE_USER='repl', SOURCE_PASSWORD='repl', SOURCE_AUTO_POSITION=1, GET_SOURCE_PUBLIC_KEY=1; START REPLICA; SET GLOBAL super_read_only=ON;" 2>/dev/null
sleep 3
docker compose exec -T mysql-replica mysql -uroot -ptest -e "SHOW REPLICA STATUS\G" 2>/dev/null | grep -E 'Replica_(IO|SQL)_Running:'
