# Cambios aplicados – BRUMAP Almacén Empresarial

## Interfaz y organización
- Se retiraron del menú/interfaz los apartados: Recepción de Materiales, Stock de materiales, Producción y Envío de Productos Terminados.
- El módulo **Almacén** quedó ubicado debajo de Dashboard.
- Se renombró **Almacén Pro** a **Almacén**.
- Se cambió “Catálogo de materiales trazables” a **Catálogo de materiales**.

## Catálogo de materiales
- Se mantienen: código de barra/etiqueta, nombre del material, categoría, lote, ubicación, stock inicial, stock mínimo y proveedor.
- Se eliminó de la pantalla: stock crítico y costo unitario.
- Unidad ahora es lista desplegable con: Kilogramos, Unidades, Caja y Agregar unidad.
- Las unidades personalizadas se guardan localmente en el navegador y se replican en los selectores.

## Manejo rápido por código o nombre
- El campo principal permite escanear con pistola de código de barras o escribir el nombre/primeras letras del material.
- Se agregó autocompletado por código o nombre.
- Movimientos soportados: Entrada / recepción, Dispensamiento / salida y Ajuste directo.
- Cada movimiento deja registro en Kardex.

## Trazabilidad
- Las entradas se registran como movimiento de Kardex.
- Los dispensamientos descuentan stock y quedan en Kardex.
- Los conteos físicos comparan stock de sistema contra stock contado; opcionalmente aplican ajuste.
- Se agregaron transacciones en operaciones críticas para reducir inconsistencias.

## Productos terminados
- Se reemplazó stock mínimo por cantidad producida.
- Unidad ahora permite Kilogramos, Cajas, Unidades y Agregar unidad.
- Si un producto ya existe, al registrarlo nuevamente se suma la cantidad producida al stock acumulado.
- Se agregó historial de producción y movimientos de producto terminado.
- Cliente relacionado se toma desde la lista de clientes.

## Órdenes de producción
- Se eliminó el campo Responsable.
- Se agregaron Fecha de inicio y Fecha final como campos de solo fecha.

## Envío de productos terminados
- Se agregó una pestaña para registrar envíos de productos terminados.
- El envío descuenta del stock acumulado del producto terminado.
- Cada envío queda registrado con producto, cliente, cantidad, unidad, usuario, fecha y observación.

## Exportaciones y filtros
- Se agregaron exportaciones PDF para: Materiales, Kardex, Productos terminados y Envíos de productos terminados.
- Se agregaron filtros por texto y rango de fechas en tablas principales de Almacén.
- Se ajustaron tablas para envolver texto correctamente y evitar palabras cortadas o columnas mal aprovechadas.

## Seguridad y robustez
- Se dejó de sobrescribir la contraseña del supervisor protegido en cada arranque.
- Se eliminó el log de contraseña inicial del supervisor protegido.
- Se ajustó CSP para permitir Chart.js desde jsDelivr, porque el HTML original lo carga desde CDN.
- Se agregó `package-lock.json` para instalaciones más reproducibles.
