# BRUMAP Inventario — Sistema de Almacén, Producción y Trazabilidad

Sistema web interno para controlar inventario, recepciones, stock, producción, envíos, productos defectuosos, maquinaria, repuestos, usuarios, auditoría y trazabilidad de materiales mediante códigos de barra.

El proyecto está preparado para ejecutarse en Docker y desplegarse en un VPS con bajo consumo de recursos.

---

## 1. Funcionalidades principales

### Panel general

- Dashboard inicial con resumen operativo.
- Recepciones de materiales.
- Control de stock.
- Retiros y consumos.
- Producción.
- Productos defectuosos.
- Envíos.
- Maquinaria.
- Repuestos.
- Gestión de usuarios.
- Auditoría controlada.
- Exportación PDF y Excel.
- Backup y restauración de base de datos.

### Almacén Pro

- Catálogo de materiales trazables.
- Código de barra por material.
- Entrada de stock por escaneo.
- Salida de stock por escaneo.
- Ajuste directo de stock.
- Recuento físico.
- Kardex por material.
- Stock mínimo y stock crítico.
- Alertas de stock bajo o crítico.
- Proveedores.
- Clientes.
- Productos terminados.
- Órdenes de producción.

---

## 2. Stack técnico

- Node.js
- Express
- SQLite
- HTML
- CSS
- JavaScript vanilla
- Docker
- Docker Compose

---

## 3. Estructura del proyecto

```txt
BRUMAP_INVENTARIO/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── server.js
├── public/
│   ├── index.html
│   ├── panel.html
│   └── assets/
│       ├── css/
│       │   └── style.css
│       ├── js/
│       │   ├── app.js
│       │   └── login.js
│       └── img/
├── Data/                 # Se crea en producción; no subir a GitHub
├── .gitignore
├── .dockerignore
└── README.md
```

---

## 4. Requisitos

Para desarrollo local o VPS:

- Docker
- Docker Compose
- Git

Verificar instalación:

```bash
docker --version
docker compose version
git --version
```

---

## 5. Instalación local con Docker

Entrar a la carpeta del proyecto:

```bash
cd BRUMAP_INVENTARIO
```

Construir y levantar:

```bash
docker compose up --build -d
```

Ver contenedores:

```bash
docker compose ps
```

Ver logs:

```bash
docker logs --tail=80 brumap_inventario
```

Abrir en navegador:

```txt
http://localhost:3000
```

Verificar salud del servicio:

```bash
curl http://localhost:3000/healthz
```

---

## 6. Credenciales iniciales

```txt
Usuario: operario
Contraseña: admin
Rol: operario
```

```txt
Usuario: administrador
Contraseña: admin
Rol: administrador
```

```txt
Usuario: supervisor
Contraseña: Admin
Rol: supervisor
```

Importante: la contraseña del usuario `supervisor` usa **A mayúscula**.

En producción se recomienda cambiar las contraseñas inmediatamente.

---

## 7. Configuración Docker

El servicio expone el puerto:

```txt
3000:3000
```

La base de datos se conserva en volumen local:

```yaml
volumes:
  - ./Data:/usr/src/app/Data
```

Esto significa que aunque el contenedor se reconstruya, los datos se mantienen en la carpeta `Data` del servidor.

---

## 8. Variables de entorno recomendadas

En `docker-compose.yml` se pueden configurar:

```env
NODE_ENV=production
PORT=3000
SESSION_SECRET=cambiar_por_clave_segura
AUDIT_ENABLED=1
AUDIT_LEVEL=normal
AUDIT_RETENTION_DAYS=120
AUDIT_MAX_ROWS=15000
AUDIT_DETAIL_MAX_CHARS=350
```

### Recomendación para VPS pequeño

```env
AUDIT_ENABLED=1
AUDIT_LEVEL=minimal
AUDIT_RETENTION_DAYS=90
AUDIT_MAX_ROWS=8000
AUDIT_DETAIL_MAX_CHARS=250
```

### Recomendación equilibrada

```env
AUDIT_ENABLED=1
AUDIT_LEVEL=normal
AUDIT_RETENTION_DAYS=120
AUDIT_MAX_ROWS=15000
AUDIT_DETAIL_MAX_CHARS=350
```

No se recomienda usar `AUDIT_LEVEL=verbose` en producción salvo para diagnóstico temporal.

---

## 9. Auditoría y trazabilidad

El sistema separa tres conceptos:

```txt
Kardex: movimientos reales de inventario.
Auditoría: acciones sensibles o administrativas.
Logs técnicos: errores o diagnóstico del servidor.
```

La auditoría no debe reemplazar al Kardex. Para movimientos normales de stock se usa Kardex; para acciones críticas se usa auditoría.

Eventos recomendados para auditoría:

- Login y logout.
- Creación de usuarios.
- Cambio de roles.
- Eliminación de registros.
- Restauración de backup.
- Descarga de backup.
- Ajustes manuales de stock.
- Cambios importantes de configuración.

Eventos que no deberían generar auditoría excesiva:

- Cada escaneo normal.
- Cada consulta de tabla.
- Navegación entre módulos.
- Cada exportación simple.

---

## 10. Uso con lectoras de código de barra

La mayoría de pistolas lectoras USB o inalámbricas funcionan como teclado.

Flujo recomendado:

```txt
1. Entrar al módulo Almacén Pro.
2. Colocar el cursor en el campo de escaneo.
3. Escanear la etiqueta del material.
4. La lectora escribe el código automáticamente.
5. Si la lectora tiene ENTER automático, el sistema procesa el movimiento.
```

Configurar la lectora para enviar al final:

```txt
ENTER
```

o:

```txt
CR/LF
```

Usos principales:

- Entrada de material.
- Salida o consumo.
- Ajuste de stock.
- Recuento físico.
- Consulta de Kardex.

---

## 11. Backup de datos

La base de datos principal se encuentra en:

```txt
Data/brumapp.db
```

Antes de actualizar el proyecto:

```bash
cp -r BRUMAP_INVENTARIO BRUMAP_INVENTARIO_BACKUP_$(date +%F_%H%M)
```

Backup específico de la base de datos:

```bash
mkdir -p backups
cp Data/brumapp.db backups/brumapp_$(date +%F_%H%M).db
```

Restauración manual:

```bash
docker compose down
cp backups/brumapp_YYYY-MM-DD_HHMM.db Data/brumapp.db
docker compose up -d
```

---

## 12. Despliegue en VPS

Clonar el repositorio:

```bash
git clone https://github.com/CesarJoel06/BRUMAP_INVENTARIO.git
cd BRUMAP_INVENTARIO
```

Levantar:

```bash
docker compose up --build -d
```

Verificar:

```bash
docker compose ps
curl http://localhost:3000/healthz
```

Si se usa Caddy o Nginx como proxy, apuntar el dominio/subdominio hacia:

```txt
http://127.0.0.1:3000
```

---

## 13. Actualización desde GitHub en VPS

Antes de actualizar:

```bash
cp -r BRUMAP_INVENTARIO BRUMAP_INVENTARIO_BACKUP_$(date +%F_%H%M)
```

Actualizar código:

```bash
git pull origin main
docker compose down
docker compose up --build -d
```

Revisar logs:

```bash
docker logs --tail=100 brumap_inventario
```

---

## 14. Archivos que no deben subirse a GitHub

El `.gitignore` debe evitar subir:

```txt
node_modules/
Data/
*.db
*.sqlite
.env
backups/
.DS_Store
```

Nunca subir una base de datos real del cliente al repositorio.

---

## 15. Comandos útiles

Apagar sistema:

```bash
docker compose down
```

Reiniciar:

```bash
docker compose restart
```

Reconstruir:

```bash
docker compose up --build -d
```

Ver logs:

```bash
docker logs -f brumap_inventario
```

Entrar al contenedor:

```bash
docker exec -it brumap_inventario sh
```

Ver peso de carpeta:

```bash
du -sh .
```

Ver peso de base de datos:

```bash
du -sh Data/brumapp.db
```

---

## 16. Recomendaciones de producción

- Cambiar contraseñas iniciales.
- Cambiar `SESSION_SECRET`.
- Mantener `AUDIT_LEVEL=normal` o `minimal`.
- Hacer backup antes de cada actualización.
- No subir `Data/` a GitHub.
- Usar HTTPS mediante Caddy, Nginx o Cloudflare.
- Revisar logs periódicamente.
- No usar `AUDIT_LEVEL=verbose` por mucho tiempo.

---

## 17. Flujo recomendado para BRUMAP

```txt
1. Registrar proveedores.
2. Registrar materiales con código de barra.
3. Definir stock mínimo y crítico.
4. Registrar entradas por recepción o escaneo.
5. Registrar salidas por producción, consumo o envío.
6. Revisar Kardex cuando haya diferencias.
7. Hacer recuento físico periódicamente.
8. Exportar reportes PDF/Excel cuando se requiera.
9. Mantener backups actualizados.
```

---

## 18. Estado actual del proyecto

Versión optimizada para VPS, con frontend responsivo, módulo Almacén Pro, auditoría controlada, Docker multi-stage, imágenes optimizadas y base SQLite persistente.
