-- Guía Local / Concierge Digital
create table if not exists public.local_guide_posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null,
  category text not null default 'General',
  icon text not null default '📍',
  image_url text,
  is_active boolean not null default true,
  event_date date,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_local_guide_posts_updated_at
  before update on public.local_guide_posts
  for each row execute function public.set_updated_at();

-- Seed: Contenido real de San Pedro Sula
insert into public.local_guide_posts (title, content, category, icon, sort_order) values
  ('Hiking en el Merendón', 'Descubre las rutas de senderismo en la Sierra del Merendón con vistas panorámicas del Valle de Sula. La ruta hacia el rótulo de Coca-Cola ofrece una experiencia única al amanecer. Recomendado para grupos con guía local.', 'Naturaleza', '🏔️', 1),
  ('El verdadero sabor catracho', 'Visita el Mercado Guamilito para probar las mejores baleadas de la ciudad y comprar artesanías hondureñas. A solo 10 minutos del hotel. Los domingos hay mercado especial con productos frescos del valle.', 'Gastronomía', '🍽️', 2),
  ('Museo de Antropología e Historia', 'Conoce la rica historia del Valle de Sula, desde la era precolombina hasta la modernidad. Exhibiciones permanentes de cerámica lenca y artefactos mayas. Abierto de martes a domingo, 9am-4pm.', 'Cultura', '🏛️', 3),
  ('Parque Nacional Cusuco', 'A solo 1 hora del hotel, este parque alberga bosque nublado, quetzales y una biodiversidad impresionante. Ideal para excursiones de día completo. El hotel puede coordinar transporte y guía.', 'Naturaleza', '🌿', 4),
  ('Cafés de especialidad', 'Honduras es tierra de café premium. Descubre los 3 mejores cafés de especialidad cerca de Barrio Los Andes: Espresso Americano, Café Welchez y The Coffee Cup. Perfectos para una reunión de negocios.', 'Gastronomía', '☕', 5),
  ('Vida nocturna y networking', 'Los mejores spots para cenas ejecutivas y networking en la zona viva de San Pedro Sula. Restaurantes como Pamplona, Casa Vieja y La Cocina de Emy ofrecen ambiente exclusivo para profesionales.', 'Negocios', '🌃', 6);
