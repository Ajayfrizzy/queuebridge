import { useState, type InputHTMLAttributes, type ReactElement } from 'react';
import './password-input.css';

export function PasswordInput({
  label = 'password',
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label?: string }): ReactElement {
  const [visible, setVisible] = useState(false);
  return (
    <div className="password-input">
      <input {...props} type={visible ? 'text' : 'password'} />
      <button
        type="button"
        className="btn btn-secondary"
        aria-controls={props.id}
        aria-label={`${visible ? 'Hide' : 'Show'} ${label}`}
        onClick={() => setVisible(!visible)}
      >
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
          <circle cx="12" cy="12" r="3" />
          {visible && <path d="m3 3 18 18" />}
        </svg>
      </button>
    </div>
  );
}
