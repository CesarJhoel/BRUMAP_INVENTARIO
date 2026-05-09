# Corrección Docker / Express

Se corrigió el problema de arranque reportado:

`Error: Cannot find package '/usr/src/app/node_modules/express/index.js' imported from /usr/src/app/server.js`

## Cambios aplicados

- Se reemplazaron en `package-lock.json` las URLs internas de registry por `https://registry.npmjs.org/`.
- Se actualizó `Dockerfile` para forzar el registry público de npm.
- Se agregó limpieza de cache npm antes de instalar.
- Se agregó validación durante el build:
  - `node_modules/express/index.js`
  - `node_modules/sqlite3/lib/sqlite3.js`
- Se quitó el atributo obsoleto `version` de `docker-compose.yml`.

## Comandos recomendados

Ejecutar desde la carpeta del proyecto:

```bash
docker compose down -v
docker builder prune -f
docker compose build --no-cache
docker compose up
```

Si el contenedor arranca correctamente, abrir:

```txt
http://localhost:3000
```
