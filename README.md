# tonight! v35

## v35 update
- Moved the event photo gallery management UI out of the top of the event home page into a dedicated `フォトギャラリー管理` page.
- Added an entry button to the event home action grid.
- The dedicated page retains multi-image upload, JPEG resizing, preview, delete, and ordering controls.
- Existing visitor gallery viewing, gallery API/storage, gallery metadata synchronization, archive navigation, and v34 photo viewer behavior are retained from v34.

## Deploy
Deploy the complete project as usual. This update changes the admin UI only; the existing Worker gallery API and storage implementation are retained unchanged.


## v36 fix
- Visitor app now redraws the live schedule after the latest public database response has arrived, rather than before the asynchronous refresh completes.
- Removed the premature timer redraw and refreshes NOW header after data fetch.
- Bumped visitor asset and service-worker cache versions.
