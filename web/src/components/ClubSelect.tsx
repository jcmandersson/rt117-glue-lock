import { useState } from "react";
import { ANNAN, CLUBS, isPresetClub } from "../clubs";

interface Props {
  id: string;
  value: string;
  onChange: (club: string) => void;
  /** Tvingar ett val och döljer alternativet "Ingen klubb". */
  required?: boolean;
}

/**
 * Klubbväljare med de kända klubbarna plus "Annan" som öppnar ett fritextfält.
 * Montera om komponenten (med `key`) när den ska visa en annan medlem.
 */
export function ClubSelect({ id, value, onChange, required }: Props) {
  const [isOther, setIsOther] = useState(() => value !== "" && !isPresetClub(value));

  function selectChanged(selected: string) {
    if (selected === ANNAN) {
      setIsOther(true);
      onChange("");
    } else {
      setIsOther(false);
      onChange(selected);
    }
  }

  return (
    <>
      <select
        id={id}
        required={required}
        value={isOther ? ANNAN : value}
        onChange={(event) => selectChanged(event.target.value)}
      >
        {required ? (
          value === "" && !isOther ? (
            <option value="" disabled>
              Välj klubb
            </option>
          ) : null
        ) : (
          <option value="">Ingen klubb</option>
        )}
        {CLUBS.map((club) => (
          <option key={club} value={club}>
            {club}
          </option>
        ))}
        <option value={ANNAN}>{ANNAN}</option>
      </select>
      {isOther && (
        <input
          type="text"
          aria-label="Egen klubb eller förening"
          placeholder="Skriv klubbens namn"
          maxLength={60}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          style={{ marginTop: 8 }}
        />
      )}
    </>
  );
}
