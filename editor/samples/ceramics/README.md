# Ceramics samples

`italy-by-period.graph.json` holds 73 vessels of continental Italy, from the Early Bronze Age to the Archaic period
(2300–480 BC): one vessel of each form per period. Each is a `freeform/vessel` node turned from its drawn section at
its real size. Its documentation is in `meta.items`: site, context, period, form, ware, measures, and the
publication, page, plate and item number of the original drawing.

The profiles come from **AIPPD**, the Ancient Italy Pottery Profiles Dataset, v0.1, by Lorenzo Cardarelli
(doi:10.5281/zenodo.24249544), distributed under the Apache License 2.0 (`AIPPD-LICENSE`). AIPPD is Appendix A of:

> Cardarelli, L. 2024. *Morphological variability and standardisation of vessel shapes in the 2nd and first half of
> the 1st millennium BC in continental Italy. A data science and machine learning project for the quantitative study
> of archaeological ceramic profiles*. Adrias 18. Bari: Edipuglia. doi:10.4475/0840

Changes made here: each 256 × 256 profile mask was turned into three point lists (outer profile, cavity, hollow foot)
in millimetres, by `scripts/aippd.mjs` and `scripts/aippd-profile.mjs`. In each period and form, the vessel closest
to the cell's median height whose cavity holds its documented capacity, within 12%, was kept.

Limits: AIPPD draws its profiles without handles and decoration, so the vessels have neither. Stands (sostegni) are
open at both ends and have no capacity, so none was chosen. A rim folded back down keeps only its outermost extent.

To rebuild: download and unzip the AIPPD record, unzip `data/aippd_profiles_256.npz` into `data/npz/`, then
`npm run build && node scripts/aippd.mjs <AIPPD folder> editor/samples/ceramics/italy-by-period.graph.json`.
