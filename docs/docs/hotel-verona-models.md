# Hotel Verona Modelos

Documento de referencia del dominio hotelero actual. Los diagramas reflejan la operacion del sistema despues de retirar el modelo de gimnasio, membresias y roles cliente/entrenador del flujo activo.

## Modelo Conceptual

```mermaid
flowchart TD
    Huesped[Huesped\n- id_huesped\n- nombre_completo\n- correo\n- telefono\n- documento_identidad]
    Hotel[Hotel\n- id_hotel\n- nombre_hotel\n- ciudad\n- direccion\n- estado]
    Personal[Personal Hotel\n- id_personal\n- rol\n- estado\n- correo]
    TipoHabitacion[Tipo Habitacion\n- id_tipo_habitacion\n- nombre_tipo\n- capacidad_base\n- tarifa_base]
    Habitacion[Habitacion\n- id_habitacion\n- codigo_habitacion\n- nombre_habitacion\n- capacidad\n- tarifa_noche\n- estado]
    Reserva[Reserva Hotel\n- id_reserva_hotel\n- check_in\n- check_out\n- adultos\n- ninos\n- estado\n- total_reserva]
    Pago[Pago Hotel\n- id_pago_hotel\n- monto\n- metodo_pago\n- referencia\n- estado]
    Bloqueo[Bloqueo Habitacion\n- id_bloqueo\n- fecha_inicio\n- fecha_fin\n- motivo]
    Configuracion[Configuracion Hotelera\n- hora_check_in\n- hora_check_out\n- moneda\n- porcentaje_impuesto]

    Hotel -->|opera| Personal
    Hotel -->|administra| Habitacion
    TipoHabitacion -->|clasifica| Habitacion
    Huesped -->|realiza| Reserva
    Hotel -->|recibe| Reserva
    Habitacion -->|se asigna en| Reserva
    Reserva -->|genera| Pago
    Habitacion -->|puede registrar| Bloqueo
    Configuracion -->|rige| Reserva
    Configuracion -->|rige| Pago
```

## Modelo Logico

```mermaid
erDiagram
    HUESPEDES ||--o{ RESERVAS_HOTEL : realiza
    HOTELES ||--o{ PERSONAL_HOTEL : opera
    HOTELES ||--o{ HABITACIONES : administra
    TIPOS_HABITACION ||--o{ HABITACIONES : clasifica
    HOTELES ||--o{ RESERVAS_HOTEL : recibe
    HABITACIONES ||--o{ RESERVAS_HOTEL : asigna
    RESERVAS_HOTEL ||--o{ PAGOS_HOTEL : liquida
    HABITACIONES ||--o{ BLOQUEOS_HABITACION : bloquea

    HUESPEDES {
      uuid id_huesped PK
      text nombre_completo
      text correo UK
      text telefono
      text documento_identidad
      text ciudad
      text direccion
      timestamptz fecha_registro
    }

    HOTELES {
      uuid id_hotel PK
      text nombre_hotel UK
      text ciudad
      text direccion
      text telefono
      text correo_contacto
      int estrellas
      text estado
    }

    PERSONAL_HOTEL {
      uuid id_personal PK
      uuid id_hotel FK
      text nombre_completo
      text correo UK
      text telefono
      text rol
      text estado
    }

    TIPOS_HABITACION {
      uuid id_tipo_habitacion PK
      text nombre_tipo UK
      text descripcion
      int capacidad_base
      numeric tarifa_base
    }

    HABITACIONES {
      uuid id_habitacion PK
      uuid id_hotel FK
      uuid id_tipo_habitacion FK
      text codigo_habitacion
      text nombre_habitacion
      int piso
      int capacidad
      numeric tarifa_noche
      text estado
    }

    RESERVAS_HOTEL {
      uuid id_reserva_hotel PK
      uuid id_huesped FK
      uuid id_hotel FK
      uuid id_habitacion FK
      timestamptz check_in
      timestamptz check_out
      int adultos
      int ninos
      text estado
      text origen_reserva
      numeric total_reserva
      numeric anticipo
      text observaciones
    }

    PAGOS_HOTEL {
      uuid id_pago_hotel PK
      uuid id_reserva_hotel FK
      numeric monto
      text metodo_pago
      text referencia
      timestamptz fecha_pago
      text estado
    }

    BLOQUEOS_HABITACION {
      uuid id_bloqueo PK
      uuid id_habitacion FK
      timestamptz fecha_inicio
      timestamptz fecha_fin
      text motivo
    }

    CONFIGURACION_HOTELERA {
      text id_config PK
      time hora_check_in
      time hora_check_out
      text moneda
      numeric porcentaje_impuesto
      boolean permite_sobreventa
    }
```

## Observaciones de diseño

- El huesped es la entidad principal de relacion comercial y reemplaza el antiguo concepto de cliente.
- Las reservas se gestionan contra inventario fisico de habitaciones, no contra programaciones de actividades.
- Los pagos siempre se registran contra una reserva hotelera; no existen membresias activas en el modelo actual.
- El personal hotelero se administra por hotel y sirve como base operativa para recepcion, gerencia, limpieza, soporte y administracion.
- La configuracion hotelera centraliza horarios operativos, moneda, impuestos y politica de sobreventa.