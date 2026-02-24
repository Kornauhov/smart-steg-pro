export default function Icon({ name, size = 20, className = "" }) {
  return (
    <i
      data-lucide={name}
      style={{ width: size, height: size }}
      className={className}
    />
  );
}
