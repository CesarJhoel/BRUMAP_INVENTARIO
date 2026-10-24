# BRUMAP Inventario

Sistema interno para gestionar materiales, existencias, producción y despachos. Incluye Kardex, recuentos físicos, proveedores, clientes, descartes, maquinaria, repuestos y copias de seguridad.

Interfaz en español, adaptable a móvil, con temas claro y oscuro. Utiliza **Node.js 24, Express y SQLite**; no necesita un servidor de base de datos adicional.

[Instalación](#instalación-con-docker) · [Credenciales](#acceso-y-credenciales) · [Migración](#migrar-una-base-existente) · [Configuración](#configuración) · [Uso](#uso-del-sistema) · [Respaldos](#copias-de-seguridad) · [Solución de problemas](#solución-de-problemas)

## Instalación con Docker

### Requisitos

- Docker Engine o Docker Desktop con el motor en ejecución y Docker Compose disponible.
- Acceso a Internet durante la primera construcción, para descargar la imagen y las dependencias.
- Una terminal compatible con `sh`: macOS, Linux o WSL en Windows.

No necesitas instalar Node.js en el equipo para usar Docker. Comprueba el entorno:

```sh
docker info
docker compose version
```

Ejecuta los comandos siguientes **desde la raíz del proyecto**, donde están `Dockerfile` y `docker-compose.yml`. Si descargaste el ZIP, entra en la carpeta `brumap-inventario/` después de extraerlo.

**Antes de arrancar:** elige entre una instalación vacía y la migración de tus datos. Docker guarda la información en un volumen propio; la carpeta local `Data/` no se importa automáticamente.

| Situación | Procedimiento |
| --- | --- |
| Quieres empezar sin datos | Sigue la instalación nueva de abajo. |
| Quieres conservar la información anterior | Sigue [Migrar una base existente](#migrar-una-base-existente) antes del primer arranque. |
| Ya arrancaste la aplicación y tienes un respaldo `.db` | Usa [Restaurar una copia](#restaurar-una-copia) desde el panel. |

### Instalación nueva

```sh
sh scripts/setup.sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Abre **http://localhost:3000**. El contenedor comprueba su estado mediante `/healthz`; también puedes consultarlo en **http://localhost:3000/healthz**.

`setup.sh` genera un archivo `.env` con una contraseña inicial y un secreto de sesión aleatorios. Utiliza Node.js local si está disponible o una imagen de Node en Docker. **Si `.env` ya existe, conserva su contenido**, incluso si contiene valores vacíos: revisa su configuración cuando sea necesario.

## Acceso y credenciales

En una base de datos nueva se crea una única cuenta principal:

| Dato | Valor |
| --- | --- |
| Usuario | `supervisor`, salvo que configures otro nombre en `PROTECTED_SUPERVISOR_USERNAME`. |
| Contraseña inicial | El valor de `BOOTSTRAP_PASSWORD` en tu archivo `.env`. |

Para consultar únicamente esas credenciales desde la raíz del proyecto:

```sh
sed -n -e '/^PROTECTED_SUPERVISOR_USERNAME=/p' -e '/^BOOTSTRAP_PASSWORD=/p' .env
```

Después de entrar, cambia la contraseña en **Mi cuenta** y crea las cuentas de trabajo desde **Usuarios**.

**Una base migrada o restaurada conserva sus usuarios y contraseñas.** `BOOTSTRAP_PASSWORD` solo se utiliza cuando no hay usuarios; modificarlo no restablece una contraseña existente. Un supervisor puede restablecer las contraseñas de otras cuentas desde Usuarios.

Las credenciales reales pertenecen a cada instalación. `.env` está excluido de Git y del ZIP de distribución; consérvalo de forma privada.

## Migrar una base existente

Este procedimiento copia la base anterior al volumen de Docker **antes de iniciar la nueva aplicación**.

1. Detén la versión anterior para evitar escrituras durante la migración.
2. Coloca su carpeta `Data/` en la raíz de este proyecto. Conserva `brumapp.db` y, si existe, `brumapp.db-wal` juntos.
3. Ejecuta:

```sh
sh scripts/setup.sh
docker compose config --quiet
docker compose build
docker compose run --rm --no-deps \
  -v "$PWD/Data:/import:ro" \
  --entrypoint node brumap scripts/migrate.mjs /import/brumapp.db
docker compose up -d
docker compose ps
```

La migración comprueba la integridad, incorpora las escrituras recientes del WAL y conserva los usuarios, las contraseñas y los movimientos. Trabaja sobre una copia y mantiene intactos los archivos originales.

Si el volumen de destino ya contiene `brumapp.db`, el script se detiene para evitar sobrescribirlo. En ese caso, utiliza Restaurar copia desde el panel con un respaldo válido. Después de migrar, inicia sesión con tus credenciales anteriores y revisa las cuentas en Usuarios.

El ZIP no incluye `Data/`: debes trasladar esa carpeta por separado si cambias de equipo.

## Configuración

Edita `.env` en la raíz del proyecto. `.env.example` describe las variables disponibles.

| Variable | Valor predeterminado o condición | Función |
| --- | --- | --- |
| `SESSION_SECRET` | Generado; mínimo 32 caracteres | Firma las sesiones. |
| `BOOTSTRAP_PASSWORD` | Generada; mínimo 12 caracteres y máximo 72 bytes | Contraseña de la primera cuenta en una base vacía. |
| `PROTECTED_SUPERVISOR_USERNAME` | `supervisor` | Nombre de la cuenta principal al crearla; no renombra cuentas existentes. |
| `HOST_PORT` | `3000` | Puerto publicado en el equipo anfitrión. |
| `BIND_ADDRESS` | `127.0.0.1` | Dirección en la que Docker publica la aplicación. |
| `COOKIE_SECURE` | `0` | Usa `1` cuando accedas mediante HTTPS. |
| `TRUST_PROXY` | `0` | Usa `1` si hay un único proxy de confianza delante de la aplicación. |
| `AUDIT_ENABLED` | `1` | Usa `0` para desactivar eventos administrativos; el Kardex se conserva. |
| `AUDIT_LEVEL` | `minimal` | Nivel de eventos: `minimal`, `normal` o `verbose`. |
| `AUDIT_RETENTION_DAYS` | `90` | Días de conservación de eventos administrativos. |
| `AUDIT_MAX_ROWS` | `8000` | Máximo de eventos administrativos conservados. |

Después de modificar `.env`, recrea el contenedor para aplicar los valores:

```sh
docker compose config --quiet
docker compose up -d --force-recreate
```

### Acceso local, red y VPS

| Entorno | Configuración | Dirección de acceso |
| --- | --- | --- |
| Solo este equipo | `BIND_ADDRESS=127.0.0.1`, `COOKIE_SECURE=0`, `TRUST_PROXY=0` | `http://localhost:3000` |
| Red local | `BIND_ADDRESS=0.0.0.0`, `COOKIE_SECURE=0`, `TRUST_PROXY=0` | `http://IP_DEL_EQUIPO:3000` |
| VPS con proxy HTTPS | `BIND_ADDRESS=127.0.0.1`, `COOKIE_SECURE=1`, `TRUST_PROXY=1` | `https://tu-dominio` |

Si cambias `HOST_PORT`, sustituye `3000` en las direcciones de acceso. Para la red local, permite ese puerto en el firewall del equipo.

En un VPS, coloca Caddy o Nginx delante de `http://127.0.0.1:3000`. El proxy debe conservar `Host` e indicar `X-Forwarded-Proto: https`. La configuración de dominio, certificado y proxy se realiza en el servidor.

### Dónde se guardan los datos

- **Docker:** volumen `brumap_data`, montado en `/app/Data` dentro del contenedor. Compose añade normalmente el nombre del proyecto al nombre real del volumen.
- **Ejecución local con Node.js:** carpeta `Data/` del proyecto, salvo que definas `DATA_DIR`.
- **Configuración privada:** archivo `.env` del equipo anfitrión.

Mantén el mismo nombre de proyecto de Compose al actualizar. Cambiar de carpeta o usar otro nombre con `-p` puede crear un volumen distinto y mostrar una instalación vacía.

## Uso del sistema

### Flujo de trabajo

1. Registra **proveedores y clientes**.
2. Crea los **materiales** con código, unidad, ubicación y niveles mínimo y crítico.
3. Registra entradas y salidas en **Movimientos**. Consulta sus saldos en **Kardex**.
4. Planifica **órdenes de producción** y complétalas para incorporar las unidades pendientes al stock de productos terminados.
5. Registra producción adicional en **Productos terminados**, cuando corresponda.
6. Crea **Envíos** indicando producto, cantidad y cliente; el sistema descuenta las existencias disponibles.
7. Registra **Descartes** y utiliza **Recuentos físicos** para comprobar diferencias de inventario.

El panel inicial resume existencias, materiales por reponer, órdenes en curso y movimientos recientes. Las tablas ofrecen búsqueda y los filtros correspondientes a cada módulo. Los módulos con botones Excel o PDF permiten descargar reportes.

### Reglas de inventario

- **Cantidades enteras:** también para kg, litros o metros. Si necesitas fracciones, trabaja con una unidad menor, como gramos o mililitros. La unidad de un material con movimientos no se puede cambiar.
- **Entradas y salidas:** suman o restan la cantidad indicada. Los envíos y las salidas requieren stock suficiente.
- **Ajustes absolutos:** establecen el saldo real; requieren motivo y confirmación. Por ejemplo, con stock `10`, una entrada de `3` deja `13`, una salida de `2` deja `11` y un ajuste a `4` deja `4`.
- **Órdenes completadas:** incorporan la producción pendiente una sola vez. El consumo de materiales se registra por separado en Movimientos.
- **Descartes:** solo descuentan del almacén si activas esa opción. Los descartes que descontaron stock se conservan como historial.
- **Recuentos:** comparan el stock del sistema con el físico. Solo modifican el saldo si activas la opción de aplicar ajuste.
- **Archivo de materiales:** un supervisor puede archivar materiales con stock cero y reactivarlos desde el filtro **Archivados**. El historial se conserva.

Los lectores de códigos de barras funcionan como teclado. En Movimientos, escanea el código completo y pulsa Enter para pasar al campo de cantidad; confirma el registro con el botón. También puedes introducir el nombre exacto del material.

### Roles y permisos

| Rol | Permisos |
| --- | --- |
| Operario | Consultar inventario, producción, contactos, descartes y reportes disponibles; cambiar su contraseña. |
| Administrador | Registrar movimientos, producción, envíos, descartes y recuentos; crear y editar catálogos; gestionar maquinaria y repuestos. |
| Supervisor | Todos los anteriores; gestionar usuarios, archivar y reactivar materiales, eliminar contactos sin registros asociados y gestionar respaldos. |

La cuenta principal no se puede eliminar ni cambiar de rol. Su contraseña sí se puede cambiar. Los permisos se comprueban en el servidor.

## Copias de seguridad

### Descargar una copia

Entra como supervisor y abre **Copias de seguridad** para descargar un archivo `.db`. La copia incluye la información de negocio y los usuarios, con las escrituras recientes de SQLite WAL.

Guarda una copia fuera del equipo o servidor donde funciona la aplicación y conserva `.env` por separado. Los reportes Excel y PDF sirven para consultar información; la restauración completa utiliza el respaldo `.db`.

### Restaurar una copia

1. Entra como supervisor en **Copias de seguridad → Restaurar copia**.
2. Selecciona un respaldo completo `.db` de BRUMAP, de hasta **50 MiB**.
3. Confirma la restauración y vuelve a iniciar sesión con una cuenta incluida en la copia.

La restauración reemplaza la información actual, valida la integridad y exige que la copia contenga una cuenta de supervisor. Antes de reemplazarla, guarda una copia de la base actual; si falla la aplicación del esquema, recupera la base anterior. Una restauración correcta cierra las sesiones activas.

Las copias previas se conservan como `brumapp_pre_restore_*.db` en `/app/Data`. Puedes verlas con:

```sh
docker compose exec brumap ls /app/Data
```

Evita copiar únicamente `brumapp.db` mientras la aplicación está en uso: puede haber movimientos pendientes en el WAL. Para una migración con archivos originales, sigue el procedimiento de migración con la versión anterior detenida.

## Actualización y comandos habituales

Antes de sustituir el código, descarga un respaldo. Conserva `.env` y el nombre del proyecto de Compose. Después de copiar la nueva versión:

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 brumap
```

| Acción | Comando |
| --- | --- |
| Detener sin eliminar contenedores | `docker compose stop` |
| Iniciar | `docker compose up -d` |
| Ver estado y salud | `docker compose ps` |
| Seguir registros técnicos | `docker compose logs -f brumap` |
| Retirar contenedores conservando el volumen | `docker compose down` |

**`docker compose down -v` elimina el volumen y los datos.** No lo uses para actualizar ni para resolver un problema de acceso.

## Solución de problemas

| Problema | Qué revisar |
| --- | --- |
| Docker no responde o indica que no puede conectar con el motor | Inicia Docker Desktop o el servicio de Docker y comprueba `docker info`. |
| Compose pide `SESSION_SECRET` o `BOOTSTRAP_PASSWORD` | Ejecuta `sh scripts/setup.sh`. Si `.env` ya existía, revisa los valores vacíos; el instalador no lo sobrescribe. |
| El puerto está ocupado | Cambia `HOST_PORT` en `.env`, recrea el contenedor y usa el nuevo puerto en el navegador. |
| La contraseña inicial no funciona después de migrar o restaurar | Usa una cuenta de la base anterior. Cambiar `BOOTSTRAP_PASSWORD` no cambia las contraseñas guardadas. |
| La migración indica que el destino ya tiene una base | Usa Restaurar copia desde el panel con un respaldo válido; no elimines el volumen para reintentar. |
| Los datos parecen haber desaparecido tras cambiar de carpeta | Revisa el nombre del proyecto de Compose y el volumen asociado. Puede haberse creado otra instalación. |
| Otro equipo no puede acceder | Revisa `BIND_ADDRESS=0.0.0.0`, la IP del servidor, `HOST_PORT` y el firewall. |
| El inicio de sesión no se mantiene | En HTTP usa `COOKIE_SECURE=0`. En HTTPS revisa `COOKIE_SECURE=1`, `TRUST_PROXY=1` y los encabezados del proxy. |
| El contenedor se reinicia o aparece sin salud | Consulta `docker compose logs --tail=100 brumap` y comprueba la configuración antes de volver a arrancar. |

## Desarrollo y validación

Para trabajar sin Docker necesitas **Node.js 24 y npm**. Desde la raíz:

```sh
npm ci
npm run setup
npm run check
npm test
npm run dev
```

El modo local usa `Data/`, por lo que abrir esta copia del proyecto puede cargar la base anterior. Las pruebas, en cambio, utilizan bases temporales y no modifican `Data/`. Cubren ajustes de stock, transacciones, concurrencia de producción y envíos, sesiones persistentes, copias con WAL, exportación Excel y utilidades de interfaz.

### Estructura del proyecto

```text
brumap-inventario/
├── server.js             Servidor, autenticación y API
├── lib/                  Inventario, producción, SQLite, sesiones y Excel
├── public/               Interfaz, estilos e imágenes
├── scripts/              Configuración, migración y empaquetado
├── test/                 Pruebas de regresión
├── Dockerfile            Imagen de producción
├── docker-compose.yml    Servicio y volumen persistente
├── .env.example          Plantilla de configuración
└── README.md             Instalación y operación
```

### Generar el paquete de distribución

Con Node.js 24:

```sh
node scripts/package.mjs
```

Genera **`release/brumap-inventario-docker.zip`**, con código, pruebas, configuración de ejemplo y esta guía. Excluye `Data/`, `.env`, dependencias instaladas e historial de Git. En el equipo de destino, extrae el ZIP y sigue la instalación nueva o la migración según corresponda.

Referencias técnicas: [SQLite en Node.js](https://nodejs.org/api/sqlite.html) y [variables de entorno en Docker Compose](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).
