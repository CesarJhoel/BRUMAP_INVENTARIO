# BRUMAP Inventario - Almacén Pro

Versión ampliada con módulos operativos para almacén, trazabilidad y producción.

## Funciones agregadas

- Catálogo de materiales trazables.
- Registro de códigos de barra por material.
- Compatibilidad con pistolas lectoras de código de barras que funcionan como teclado + Enter.
- Registro rápido de entradas, salidas y ajustes por escaneo.
- Stock mínimo y stock crítico por material.
- Alertas visuales de stock: OK, BAJO y CRÍTICO.
- Kardex por material/código de barra.
- Conteo físico de inventario con opción de aplicar ajuste directo al stock.
- Proveedores.
- Clientes.
- Productos terminados.
- Órdenes de producción.
- Dashboard PRO con indicadores de materiales, stock crítico/bajo y órdenes abiertas.

## Uso con lectoras de código de barras

La mayoría de pistolas lectoras USB o inalámbricas trabajan como teclado. No requieren integración especial.

1. Entra al módulo **Almacén Pro**.
2. Haz clic en el campo **Escanear o escribir código de barra**.
3. Escanea la etiqueta.
4. La lectora escribirá el código y normalmente enviará Enter.
5. El sistema registra el movimiento seleccionado: entrada, salida o ajuste.

Si la lectora no envía Enter automáticamente, configúrala para agregar sufijo `Enter` o `CR/LF` después del escaneo.

## Flujo recomendado

1. Crear proveedores.
2. Crear materiales con código de barra, unidad, ubicación, stock mínimo y stock crítico.
3. Usar entrada/salida por escaneo para movimientos diarios.
4. Revisar Kardex para trazabilidad.
5. Hacer conteo físico periódico y aplicar ajuste solo con usuario supervisor/administrador.
6. Registrar productos terminados y órdenes de producción.

## Docker

```bash
docker compose down
docker compose up --build -d
```

Abrir:

```text
http://localhost:3000
```

Healthcheck:

```bash
curl http://localhost:3000/healthz
```

## Credenciales por defecto

```text
operario / admin
administrador / admin
supervisor / Admin
```

La cuenta `supervisor` usa `Admin` con A mayúscula.
