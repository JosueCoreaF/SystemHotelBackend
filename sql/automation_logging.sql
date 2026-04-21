create table if not exists public.bitacora_actividad (
    id_actividad uuid primary key default gen_random_uuid(),
    tipo text not null,
    accion text not null,
    descripcion text not null,
    entidad_id uuid,
    usuario_id uuid,
    created_at timestamptz not null default now()
);

create index if not exists idx_bitacora_actividad_created_at
on public.bitacora_actividad (created_at desc);

create index if not exists idx_bitacora_actividad_tipo
on public.bitacora_actividad (tipo, created_at desc);

-- Función centralizada para log de actividad del hotel
create or replace function public.fn_log_hotel_activity()
returns trigger
language plpgsql
security definer
as $$
declare
    v_usuario_id uuid;
    v_tipo text;
    v_accion text;
    v_descripcion text;
    v_entidad_id uuid;
begin
    -- Intentar obtener el ID del usuario desde auth.uid() (Supabase Auth)
    v_usuario_id := auth.uid();
    v_accion := lower(TG_OP);
    
    if (TG_TABLE_NAME = 'reservas_hotel') then
        v_tipo := 'reserva';
        v_entidad_id := new.id_reserva_hotel;
        
        if (TG_OP = 'INSERT') then
            v_descripcion := format('Nueva reserva creada para huésped ID: %s. Total: %s', new.id_huesped, new.total_reserva);
        elsif (TG_OP = 'UPDATE') then
            if (old.estado <> new.estado) then
                v_descripcion := format('Estado de reserva %s cambiado de %s a %s', new.id_reserva_hotel, old.estado, new.estado);
            else
                v_descripcion := format('Reserva %s modificada (Check-in: %s, Total: %s)', new.id_reserva_hotel, new.check_in, new.total_reserva);
            end if;
        end if;
        
    elsif (TG_TABLE_NAME = 'pagos_hotel') then
        v_tipo := 'pago';
        v_entidad_id := new.id_pago_hotel;
        
        if (TG_OP = 'INSERT') then
            v_descripcion := format('Nuevo pago de %s registrado vía %s para reserva %s', new.monto, new.metodo_pago, new.id_reserva_hotel);
        elsif (TG_OP = 'UPDATE') then
             v_descripcion := format('Pago %s actualizado. Monto: %s, Estado: %s', new.id_pago_hotel, new.monto, new.estado);
        end if;

    elsif (TG_TABLE_NAME = 'habitaciones') then
        v_tipo := 'mantenimiento';
        v_entidad_id := new.id_habitacion;
        
        if (TG_OP = 'UPDATE' and old.estado <> new.estado) then
            v_descripcion := format('Habitación %s (%s) cambió estado: %s -> %s', new.nombre_habitacion, new.codigo_habitacion, old.estado, new.estado);
        else
            v_descripcion := format('Datos de habitación %s actualizados', new.codigo_habitacion);
        end if;
    end if;

    -- Insertar en la bitácora si hay descripción
    if (v_descripcion is not null) then
        insert into public.bitacora_actividad (
            tipo,
            accion,
            descripcion,
            entidad_id,
            usuario_id
        ) values (
            v_tipo,
            v_accion,
            v_descripcion,
            v_entidad_id,
            v_usuario_id
        );
    end if;

    return new;
end;
$$;

-- Triggers para Reservas
drop trigger if exists tr_log_reservas_hotel on public.reservas_hotel;
create trigger tr_log_reservas_hotel
after insert or update on public.reservas_hotel
for each row execute function public.fn_log_hotel_activity();

-- Triggers para Pagos
drop trigger if exists tr_log_pagos_hotel on public.pagos_hotel;
create trigger tr_log_pagos_hotel
after insert or update on public.pagos_hotel
for each row execute function public.fn_log_hotel_activity();

-- Triggers para Habitaciones
drop trigger if exists tr_log_habitaciones on public.habitaciones;
create trigger tr_log_habitaciones
after insert or update on public.habitaciones
for each row execute function public.fn_log_hotel_activity();
