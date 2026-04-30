# BRUMAP Inventario - versión curada para VPS

Esta versión mantiene las funciones existentes, pero reduce peso, evita recursos innecesarios y controla el crecimiento de la auditoría.

## Cambios principales

- Dockerfile multi-stage: las herramientas de compilación quedan fuera de la imagen final.
- Imágenes optimizadas: favicon y logos reducidos sin afectar el uso normal del sistema.
- `.dockerignore` ampliado para no copiar `.git`, `Data`, backups ni archivos temporales al build.
- SQLite optimizado con WAL, `busy_timeout`, `synchronous=NORMAL` y `foreign_keys=ON`.
- Auditoría `event_logs` optimizada:
  - evita duplicar movimientos de escáner que ya se guardan en Kardex/conteo físico;
  - limita detalle de eventos;
  - conserva un máximo configurable de filas;
  - borra eventos antiguos automáticamente;
  - corrige la ruta de exportación XLSX que antes quedaba anidada dentro de la consulta de eventos.
- Docker Compose con límites de logs del contenedor y healthcheck.

## Variables recomendadas de auditoría

En `docker-compose.yml`:

```env
AUDIT_ENABLED=1
AUDIT_LEVEL=normal
AUDIT_RETENTION_DAYS=120
AUDIT_MAX_ROWS=15000
AUDIT_DETAIL_MAX_CHARS=350
```

Niveles:

- `normal`: recomendado. Registra seguridad, usuarios, altas/ediciones relevantes, backups y eliminaciones. No duplica escaneos de almacén porque estos ya están en Kardex.
- `verbose`: registra todo. Úsalo solo para diagnóstico temporal.
- `minimal`: registra solo seguridad, usuarios, backups y eliminaciones.
- `AUDIT_ENABLED=0`: desactiva `event_logs`. No desactiva Kardex ni conteos.

## Despliegue

```bash
docker compose down
docker compose up --build -d
```

Verificar:

```bash
curl http://localhost:3000/healthz
docker compose ps
docker logs --tail=80 brumap_inventario
```

## Backup antes de reemplazar

```bash
cp -r BRUMAP_INVENTARIO BRUMAP_INVENTARIO_BACKUP_$(date +%F_%H%M)
```

La base de datos vive en:

```text
./Data/brumapp.db
```

## Limpieza manual de auditoría

El sistema limpia automáticamente, pero también existe un endpoint interno para supervisor:

```http
POST /api/event-logs/cleanup
```

## Credenciales iniciales

```text
operario / admin
administrador / admin
supervisor / Admin
```

Cambia estas claves antes de usarlo en producción.
