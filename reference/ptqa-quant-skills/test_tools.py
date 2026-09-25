import tempfile,unittest
from pathlib import Path
from quant_tools import *
class Tests(unittest.TestCase):
 def test_caps(self):
  r=position_size(10000,1,100,95,fee_bps=10,slippage=.1,lot=3)
  self.assertEqual(r['units'],'18');self.assertLessEqual(Decimal(r['estimated_stop_loss_with_costs']),100)
 def test_invalid_stop(self):
  with self.assertRaises(ValueError):position_size(10000,1,100,101)
 def test_short(self):self.assertEqual(position_size(10000,1,100,105,side='short')['units'],'20')
 def test_nonfinite(self):
  with self.assertRaises(ValueError):position_size(float('nan'),1,100,95)
 def test_bad_bars(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'b.csv';p.write_text('timestamp,open,high,low,close,volume\n2026-01-01T00:00:00Z,100,99,90,100,1000\n');self.assertFalse(data_quality(p)['passed'])
 def test_costs(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'t.csv';p.write_text('trade_id,exit_time,gross_pnl,costs,initial_risk,setup\na,2026-01-01T00:00:00Z,100,10,100,test\nb,2026-01-02T00:00:00Z,-50,10,100,test\n')
   r=journal(p);self.assertEqual(r['net_pnl'],30);self.assertEqual(r['profit_factor'],1.5);self.assertEqual(r['closed_trade_drawdown_cash'],60)
if __name__=='__main__':unittest.main()
