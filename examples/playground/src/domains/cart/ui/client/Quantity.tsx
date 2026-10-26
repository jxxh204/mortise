import type { UI } from '@mortise/react';
import { QuantityEditable } from '../../../../contracts/quantity-editable';
export default function Quantity({ state: { quantity, min, max }, commands: { setQuantity }, props: { label } }: UI<typeof QuantityEditable, {
    label: string;
}>) {
    return <div className="quantity">
  <span>{label}</span>
  <div><button aria-label={label + ' 감소'} disabled={setQuantity.pending || quantity <= min} onClick={() => void setQuantity.execute(quantity - 1)}>−</button><strong>{quantity}</strong><button aria-label={label + ' 증가'} disabled={setQuantity.pending || quantity >= max} onClick={() => void setQuantity.execute(quantity + 1)}>+</button></div>
  <button className="subtle" disabled={setQuantity.pending} onClick={() => void setQuantity.execute(11)}>잘못된 수량 전송</button>
  {setQuantity.pending && <small>서버 저장·조회 중…</small>}
  {setQuantity.error && <small role="alert">{setQuantity.error.message}</small>}
 </div>;
}
