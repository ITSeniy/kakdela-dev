# Прод-образ speedy. Контекст сборки — КОРЕНЬ репозитория:
#   docker build -f packages/speedy/Dockerfile .
# (docker-compose.app.yml делает именно так.)
#
# Почему tsx, а не `tsc && node dist`: ginzu экспортирует TS-исходники
# (`"exports": { ".": "./src/index.ts" }`), поэтому скомпилированный dist
# speedy не запускается голым node — импорты @kakdela/ginzu резолвятся
# в .ts-файлы. tsx — тот же рантайм, что и в dev; для 15-20 друзей
# оверхед нулевой.
#
# В образ включён francine: миграции/сидинг/инвайты на VPS гоняются
# одноразовым контейнером:
#   docker compose -f docker-compose.app.yml run --rm speedy pnpm francine migrate

FROM node:24-alpine

WORKDIR /repo
RUN npm i -g pnpm@9.12.0

# Сначала только манифесты — слой с pnpm install кэшируется, пока не меняются
# зависимости. Манифесты ВСЕХ workspace-пакетов нужны, иначе frozen-lockfile
# не пройдёт валидацию (lockfile знает обо всех importers).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY patches patches
COPY packages/ginzu/package.json      packages/ginzu/
COPY packages/speedy/package.json     packages/speedy/
COPY packages/francine/package.json   packages/francine/
COPY packages/big-cheese/package.json packages/big-cheese/
COPY packages/polly/package.json      packages/polly/

# Ставим только то, что нужно speedy и francine (с их workspace-зависимостями).
RUN pnpm install --frozen-lockfile --filter @kakdela/speedy... --filter @kakdela/francine...

COPY packages/ginzu    packages/ginzu
COPY packages/speedy   packages/speedy
COPY packages/francine packages/francine

# Скрипты пакетов читают ../../.env через --env-file; в контейнере конфиг
# приходит из environment (docker compose env_file), поэтому достаточно
# пустого файла — node --env-file НЕ перетирает уже заданные переменные.
RUN touch /repo/.env

EXPOSE 3001
CMD ["pnpm", "--filter", "@kakdela/speedy", "start"]
