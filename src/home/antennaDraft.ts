import type { Design, DesignParam } from '../designer/types';
import { antennaDimensions, type AntennaKind, type CalculatorInput } from './antennaDimensions.ts';

const KINDS: readonly AntennaKind[] = ['dipole', 'folded_dipole', 'monopole', 'ground_plane', 'yagi', 'patch'];

/** Editable starting geometry, not a solved or matched antenna. All stored units are mm/GHz. */
export function antennaDraft(input: CalculatorInput, id: string, name: string): Design {
  if (!KINDS.includes(input.kind)) throw new Error('kind');
  const result = antennaDimensions(input);
  if (!result.ok) throw new Error(result.error);
  const param = (key: string, value: number | string, unit = 'mm'): DesignParam =>
    ({key, ...(typeof value === 'number' ? {default:value} : {expr:value}), unit});
  const design: Design = {
    schema:'fairbeam.design/1',
    units: input.frequencyGHz < 0.1 ? { length: 'm', frequency: 'MHz' } : { length: 'mm', frequency: 'GHz' },
    model:{id,name,description:'Analytical starting dimensions. Feed, mesh, domain and radiation require convergence checks; no simulated performance is claimed.'},
    params:[param('f0',input.frequencyGHz,'GHz'),param('lam','wavelength(f0)')],
    simulation:{f_min:'0.7*f0',f_max:'1.3*f0',boundaries:'PML_8',end_criteria_db:-60,max_timesteps:60000},
    materials:[{name:'pec',kind:'metal',library:'pec'}], parts:[], ports:[], resistors:[],
    mesh:{mode:'design',overrides:{},refine_features:false},
    far_field:{enabled:true,frequencies:['f0']},
  };
  if (input.kind === 'patch') {
    design.params.push(param('eps_r',input.epsilonR,''),param('h',input.heightMm),
      param('W','lam/2*sqrt(2/(eps_r+1))'),param('eps_eff','(eps_r+1)/2+(eps_r-1)/(2*sqrt(1+12*h/W))',''),
      param('delta_l','0.412*h*(eps_eff+0.3)*(W/h+0.264)/((eps_eff-0.258)*(W/h+0.8))'),
      param('L','lam/(2*sqrt(eps_eff))-2*delta_l'),param('margin','max(6*h,0.08*lam)'),
      param('feed_x','L/3'),param('feed_w','h/2'));
    design.materials.push({name:'substrate',kind:'dielectric',eps_r:'eps_r'});
    design.parts.push(
      {name:'substrate',material:'substrate',primitives:[{kind:'box',start:['-L/2-margin','-W/2-margin',0],stop:['L/2+margin','W/2+margin','h']}]},
      {name:'ground',material:'pec',primitives:[{kind:'box',start:['-L/2-margin','-W/2-margin',0],stop:['L/2+margin','W/2+margin',0]}]},
      {name:'patch',material:'pec',primitives:[{kind:'box',start:['-L/2','-W/2','h'],stop:['L/2','W/2','h']}]});
    design.ports.push({type:'lumped',number:1,R:50,start:['feed_x','-feed_w/2',0],stop:['feed_x','feed_w/2','h'],direction:'z'});
    design.model.description += ' Lossless substrate, finite PEC ground, and an editable probe at L/3 are layout choices; the feed is not matched.';
  } else if (input.kind === 'folded_dipole') {
    design.params.push(param('k',input.shortening,''),param('k_s',0.01,''),
      param('L','k*lam/2'),param('s','k_s*lam'),param('w','s/3'),param('g','lam/125'));
    design.parts.push(
      {name:'driven_arm',material:'pec',primitives:[
        {kind:'box',start:['-s/2-w/2',0,'g/2'],stop:['-s/2+w/2',0,'L/2-w']},
        {kind:'box',start:['-s/2-w/2',0,'-L/2+w'],stop:['-s/2+w/2',0,'-g/2']}]},
      {name:'folded_arm',material:'pec',primitives:[
        {kind:'box',start:['s/2-w/2',0,'-L/2+w'],stop:['s/2+w/2',0,'L/2-w']},
        {kind:'box',start:['-s/2-w/2',0,'L/2-w'],stop:['s/2+w/2',0,'L/2']},
        {kind:'box',start:['-s/2-w/2',0,'-L/2'],stop:['s/2+w/2',0,'-L/2+w']}]});
    design.ports.push({type:'lumped',number:1,R:300,start:['-s/2-w/2',0,'-g/2'],stop:['-s/2+w/2',0,'g/2'],direction:'z'});
    design.model.description += ' Two-strip PEC folded loop (0.01 wavelength center spacing, strip width s/3, feed gap wavelength/125) with an unmatched 300 ohm discrete port; length includes the end bridges and feed gap.';
  } else if (input.kind === 'ground_plane') {
    design.params.push(param('k',input.shortening,''),param('k_rad',input.shortening,''),
      param('L','k*lam/4'),param('L_rad','k_rad*lam/4'),param('w','lam/125'),param('g','lam/125'));
    design.parts.push(
      {name:'radiator',material:'pec',primitives:[{kind:'box',start:['-w/2',0,'g'],stop:['w/2',0,'L']}]},
      {name:'radials',material:'pec',primitives:[
        {kind:'box',start:['-w/2','-w/2',0],stop:['w/2','w/2',0]},
        {kind:'box',start:['w/2','-w/2',0],stop:['L_rad','w/2',0]},
        {kind:'box',start:['-L_rad','-w/2',0],stop:['-w/2','w/2',0]},
        {kind:'box',start:['-w/2','w/2',0],stop:['w/2','L_rad',0]},
        {kind:'box',start:['-w/2','-L_rad',0],stop:['w/2','-w/2',0]}]});
    design.ports.push({type:'lumped',number:1,R:50,start:['-w/2',0,0],stop:['w/2',0,'g'],direction:'z'});
    design.model.description += ' Free-space PEC strip radiator with four horizontal orthogonal quarter-wave PEC radials and an unmatched 50 ohm discrete port across the base gap.';
  } else if (input.kind === 'yagi') {
    design.params.push(param('k',input.shortening,''),param('k_r',0.495,''),param('k_d',0.44,''),
      param('k_sr',0.2,''),param('k_sd',0.15,''),
      param('L','0.473*k*lam'),param('L_r','k_r*lam'),param('L_d','k_d*lam'),
      param('s_r','k_sr*lam'),param('s_d','k_sd*lam'),param('boom','s_r+s_d'),
      param('w','lam/125'),param('g','lam/125'));
    design.parts.push(
      {name:'reflector',material:'pec',primitives:[{kind:'box',start:['-s_r-w/2',0,'-L_r/2'],stop:['-s_r+w/2',0,'L_r/2']}]},
      {name:'driven',material:'pec',primitives:[
        {kind:'box',start:['-w/2',0,'g/2'],stop:['w/2',0,'L/2']},
        {kind:'box',start:['-w/2',0,'-L/2'],stop:['w/2',0,'-g/2']}]},
      {name:'director',material:'pec',primitives:[{kind:'box',start:['s_d-w/2',0,'-L_d/2'],stop:['s_d+w/2',0,'L_d/2']}]});
    design.ports.push({type:'lumped',number:1,R:50,start:['-w/2',0,'-g/2'],stop:['w/2',0,'g/2'],direction:'z'});
    design.model.description += ' Three-element free-space PEC strip Yagi-Uda along +x (reflector, split driven dipole with an unmatched 50 ohm discrete port, and director).';
  } else {
    design.params.push(param('k',input.shortening,''),param('L',input.kind==='dipole'?'k*lam/2':'k*lam/4'),
      param('w','lam/125'),param('g','lam/125'));
    if (input.kind === 'dipole') {
      design.parts.push({name:'arms',material:'pec',primitives:[
        {kind:'box',start:['-w/2',0,'g/2'],stop:['w/2',0,'L/2']},
        {kind:'box',start:['-w/2',0,'-L/2'],stop:['w/2',0,'-g/2']}]});
      design.ports.push({type:'lumped',number:1,R:50,start:['-w/2',0,'-g/2'],stop:['w/2',0,'g/2'],direction:'z'});
    } else {
      design.params.push(param('G','0.8*lam'));
      design.parts.push({name:'radiator',material:'pec',primitives:[{kind:'box',start:['-w/2',0,'g'],stop:['w/2',0,'L']}]},
        {name:'ground',material:'pec',primitives:[{kind:'box',start:['-G/2','-G/2',0],stop:['G/2','G/2',0]}]});
      design.ports.push({type:'lumped',number:1,R:50,start:['-w/2',0,0],stop:['w/2',0,'g'],direction:'z'});
      design.model.description += ' The finite square ground is 0.8 wavelengths wide; it differs from the calculator\'s infinite-ground assumption.';
    }
    design.model.description += ' The radiator is a PEC strip, not a round wire. Strip width and feed gap default to wavelength/125; length includes the feed gap.';
  }
  return design;
}
