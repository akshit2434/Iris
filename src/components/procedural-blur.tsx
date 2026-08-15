export function ProceduralBlur({ edge, className = "" }: Readonly<{ edge: "top" | "bottom"; className?: string }>) {
  return (
    <div className={`procedural-blur procedural-blur--${edge} ${className}`} aria-hidden="true">
      <span className="procedural-blur__wash" />
      <span className="procedural-blur__layer procedural-blur__layer--1" />
      <span className="procedural-blur__layer procedural-blur__layer--2" />
      <span className="procedural-blur__layer procedural-blur__layer--3" />
      <span className="procedural-blur__layer procedural-blur__layer--4" />
    </div>
  );
}
