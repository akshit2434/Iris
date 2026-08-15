import Image from "next/image";

export function IrisMark({ size = 40, priority = false }: Readonly<{ size?: number; priority?: boolean }>) {
  return (
    <Image
      src="/brand/iris-mark.webp"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      {...(priority ? { priority: true } : { loading: "eager" as const })}
      className="iris-mark"
    />
  );
}
