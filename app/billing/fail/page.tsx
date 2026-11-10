import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';
export default async function LegacyPaymentFailure({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const values = await searchParams;
  const query = new URLSearchParams();
  for (const key of ['orderId', 'code', 'message']) {
    const value = values[key];
    if (typeof value === 'string' && value.length <= 300) query.set(key, value);
  }
  redirect('/upgrade/fail?' + query.toString());
}
