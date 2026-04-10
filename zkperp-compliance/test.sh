leo deploy --network testnet --broadcast


source .env && leo execute update_root 1234567890field \
  --network testnet \
  --private-key $ADMIN_PRIVATE_KEY \
  --broadcast

  leo execute revoke_user $ADMIN_ADDRESS \
  --network testnet \
  --private-key $ADMIN_PRIVATE_KEY \
  --broadcast

  leo execute unrevoke_user $ADMIN_ADDRESS \
  --network testnet \
  --private-key $ADMIN_PRIVATE_KEY \
  --broadcast

# First update the on-chain root to match what the JS tree computed:
  cd ~/zkperp_compliance && source .env && cd ~/zkperp_compliance && leo execute update_root 2836260221714527322861570602422678633038337180615620707727603635837571691601field \
  --network testnet \
  --private-key $ADMIN_PRIVATE_KEY \
  --broadcast

# Once confirmed, execute issue_compliance with the proof:
    cd ~/zkperp_compliance && source .env && leo execute issue_compliance "{path: [{sibling: 0field, is_left: false}, {sibling: 2198804765345369381524608828019312415992695632925817705014094806252585325957field, is_left: false}, {sibling: 5066138709908963130889766683433708275336934872887199847605756043634391800410field, is_left: false}, {sibling: 334254468135955747085685147492802704325787017569113658521131281039881290713field, is_left: false}, {sibling: 3513046929321462135511013513558016024967794440518393502524213099184499187169field, is_left: false}, {sibling: 125023883812990841212011627768759716763173379391119579562144287040389557986field, is_left: false}, {sibling: 1930709919249991074237399078909430050505127926411540027305418177543984821847field, is_left: false}, {sibling: 7654836390245626249849518175862878367211648101126724685363687379645546496235field, is_left: false}, {sibling: 5685014932420279048589652553734572063326830810102722152825275861392819968050field, is_left: false}, {sibling: 4774451516706734017082995736353893458597673699533189492628997279954470089701field, is_left: false}]}" \
  --network testnet \
  --private-key $ADMIN_PRIVATE_KEY \
  --broadcast