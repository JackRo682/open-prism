import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';
export default async function LegacyPaymentSuccess({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const values = await searchParams;
  const query = new URLSearchParams();
  for (const key of ['orderId', 'paymentKey', 'amount']) {
    const value = values[key];
    if (typeof value === 'string' && value.length <= 300) query.set(key, value);
  }
  redirect('/upgrade/success?' + query.toString());
}
